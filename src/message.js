import {ENV, DATABASE, CONST} from './env.js';
import {SHARE_CONTEXT, USER_CONFIG, CURRENT_CHAT_CONTEXT, initUserConfig} from './context.js';
import {sendMessageToTelegram, sendChatActionToTelegram} from './telegram.js';
import {sendMessageToChatGPT} from './openai.js';
import {handleCommandMessage} from './command.js';
import {errorToString} from './utils.js';

const MAX_TOKEN_LENGTH = 2048;

// 初始化当前Telegram Token
async function msgInitTelegramToken(message, request) {
  try {
    const {pathname} = new URL(request.url);
    const token = pathname.match(
        /^\/telegram\/(\d+:[A-Za-z0-9_-]{35})\/webhook/,
    )[1];
    const telegramIndex = ENV.TELEGRAM_AVAILABLE_TOKENS.indexOf(token);
    if (telegramIndex === -1) {
      throw new Error('Token not found');
    }
    SHARE_CONTEXT.currentBotToken = token;
    SHARE_CONTEXT.currentBotId = token.split(':')[0];
    SHARE_CONTEXT.usageKey = `usage:${SHARE_CONTEXT.currentBotId}`;
    if (ENV.TELEGRAM_BOT_NAME.length > telegramIndex) {
      SHARE_CONTEXT.currentBotName = ENV.TELEGRAM_BOT_NAME[telegramIndex];
    }
  } catch (e) {
    return new Response(
        e.message,
        {status: 200},
    );
  }
}


// 初始化聊天上下文
async function msgInitChatContext(message) {
  const id = message?.chat?.id;
  if (id === undefined || id === null) {
    return new Response('ID NOT FOUND', {status: 200});
  }

  /*
  message_id每次都在变的。
  私聊消息中：
    message.chat.id 是发言人id
  群组消息中：
    message.chat.id 是群id
    message.from.id 是发言人id

   没有开启群组共享模式时，要加上发言人id
   chatHistoryKey = history:chat_id:bot_id:(from_id)
   configStoreKey =  user_config:chat_id:bot_id:(from_id)
  * */

  let historyKey = `history:${id}`;
  let configStoreKey = `user_config:${id}`;
  let groupAdminKey = null;

  CURRENT_CHAT_CONTEXT.chat_id = id;

  if (SHARE_CONTEXT.currentBotId) {
    historyKey += `:${SHARE_CONTEXT.currentBotId}`;
    configStoreKey += `:${SHARE_CONTEXT.currentBotId}`;
  }

  // 标记群组消息
  if (CONST.GROUP_TYPES.includes(message.chat?.type)) {
    CURRENT_CHAT_CONTEXT.reply_to_message_id = message.message_id;
    if (!ENV.GROUP_CHAT_BOT_SHARE_MODE && message.from.id) {
      historyKey += `:${message.from.id}`;
      configStoreKey += `:${message.from.id}`;
    }
    groupAdminKey = `group_admin:${id}`;
  }

  SHARE_CONTEXT.chatHistoryKey = historyKey;
  SHARE_CONTEXT.configStoreKey = configStoreKey;
  SHARE_CONTEXT.groupAdminKey = groupAdminKey;

  SHARE_CONTEXT.chatType = message.chat?.type;
  SHARE_CONTEXT.chatId = message.chat.id;
  SHARE_CONTEXT.speekerId = message.from.id || message.chat.id;

  await initUserConfig(configStoreKey);

  return null;
}


async function msgSaveLastMessage(message) {
  if (ENV.DEBUG_MODE) {
    const lastMessageKey = `last_message:${SHARE_CONTEXT.chatHistoryKey}`;
    await DATABASE.put(lastMessageKey, JSON.stringify(message));
  }
  return null;
}


// 检查环境变量是否设置
async function msgCheckEnvIsReady(message) {
  if (!ENV.API_KEY) {
    return sendMessageToTelegram('OpenAI API Key 未设置');
  }
  if (!DATABASE) {
    return sendMessageToTelegram('DATABASE 未设置');
  }
  return null;
}

// 过滤非白名单用户
async function msgFilterWhiteList(message) {
  if (ENV.I_AM_A_GENEROUS_PERSON) {
    return null;
  }
  // 判断私聊消息
  if (SHARE_CONTEXT.chatType==='private') {
    // 白名单判断
    if (!ENV.CHAT_WHITE_LIST.includes(`${CURRENT_CHAT_CONTEXT.chat_id}`)) {
      return sendMessageToTelegram(
          `你没有权限使用这个命令, 请请联系管理员添加你的ID(${CURRENT_CHAT_CONTEXT.chat_id})到白名单`,
      );
    }
    return null;
  } else if (CONST.GROUP_TYPES.includes(SHARE_CONTEXT.chatType)) {
    // 未打开群组机器人开关,直接忽略
    if (!ENV.GROUP_CHAT_BOT_ENABLE) {
      return new Response('ID SUPPORT', {status: 200});
    }
    // 白名单判断
    if (!ENV.CHAT_GROUP_WHITE_LIST.includes(`${CURRENT_CHAT_CONTEXT.chat_id}`)) {
      return sendMessageToTelegram(
          `该群未开启聊天权限, 请请联系管理员添加群ID(${CURRENT_CHAT_CONTEXT.chat_id})到白名单`,
      );
    }
    return null;
  }
  return sendMessageToTelegram(
      `暂不支持该类型(${SHARE_CONTEXT.chatType})的聊天`,
  );
}

// 过滤非文本消息
async function msgFilterNonTextMessage(message) {
  if (!message.text) {
    return sendMessageToTelegram('暂不支持非文本格式消息');
  }
  return null;
}

// 处理群消息
async function msgHandleGroupMessage(message) {
  // 非文本消息直接忽略
  if (!message.text) {
    return new Response('NON TEXT MESSAGE', {status: 200});
  }
  // 处理群组消息，过滤掉AT部分
  const botName = SHARE_CONTEXT.currentBotName;
  if (botName) {
    let mentioned = false;
    // Reply消息
    if (message.reply_to_message) {
      if (message.reply_to_message.from.username === botName) {
        mentioned = true;
      }
    }
    if (message.entities) {
      let content = '';
      let offset = 0;
      message.entities.forEach((entity) => {
        switch (entity.type) {
          case 'bot_command':
            if (!mentioned) {
              const mention = message.text.substring(
                  entity.offset,
                  entity.offset + entity.length,
              );
              if (mention.endsWith(botName)) {
                mentioned = true;
              }
              const cmd = mention
                  .replaceAll('@' + botName, '')
                  .replaceAll(botName)
                  .trim();
              content += cmd;
              offset = entity.offset + entity.length;
            }
            break;
          case 'mention':
          case 'text_mention':
            if (!mentioned) {
              const mention = message.text.substring(
                  entity.offset,
                  entity.offset + entity.length,
              );
              if (mention === botName || mention === '@' + botName) {
                mentioned = true;
              }
            }
            content += message.text.substring(offset, entity.offset);
            offset = entity.offset + entity.length;
            break;
        }
      });
      content += message.text.substring(offset, message.text.length);
      message.text = content.trim();
    }
    // 未AT机器人的消息不作处理
    if (!mentioned) {
      return new Response('NOT MENTIONED', {status: 200});
    } else {
      return null;
    }
  }
  return new Response('NOT SET BOTNAME', {status: 200}); ;
}

// 响应命令消息
async function msgHandleCommand(message) {
  return await handleCommandMessage(message);
}

// 聊天
async function msgChatWithOpenAI(message) {
  try {
    sendChatActionToTelegram('typing').then(console.log).catch(console.error);
    const historyKey = SHARE_CONTEXT.chatHistoryKey;
    const {real: history, fake: fakeHistory} = await loadHistory(historyKey);
    const answer = await sendMessageToChatGPT(message.text, fakeHistory || history);
    history.push({role: 'user', content: message.text || ''});
    history.push({role: 'assistant', content: answer});
    await DATABASE.put(historyKey, JSON.stringify(history));
    return sendMessageToTelegram(answer);
  } catch (e) {
    return sendMessageToTelegram(`ERROR:CHAT: ${e.message}`);
  }
}

// 根据类型对消息进一步处理
export async function processMessageByChatType(message) {
  const handlerMap = {
    'private': [
      msgFilterWhiteList,
      msgFilterNonTextMessage,
      msgHandleCommand,
    ],
    'group': [
      msgHandleGroupMessage,
      msgFilterWhiteList,
      msgHandleCommand,
    ],
    'supergroup': [
      msgHandleGroupMessage,
      msgFilterWhiteList,
      msgHandleCommand,
    ],
  };
  if (!handlerMap.hasOwnProperty(SHARE_CONTEXT.chatType)) {
    return sendMessageToTelegram(
        `暂不支持该类型(${SHARE_CONTEXT.chatType})的聊天`,
    );
  }
  const handlers = handlerMap[SHARE_CONTEXT.chatType];
  for (const handler of handlers) {
    try {
      const result = await handler(message);
      if (result && result instanceof Response) {
        return result;
      }
    } catch (e) {
      console.error(e);
      return sendMessageToTelegram(
          `处理(${SHARE_CONTEXT.chatType})的聊天消息出错`,
      );
    }
  }
  return null;
}

// { real: [], fake: [] }
async function loadHistory(key) {
  const initMessage = {role: 'system', content: USER_CONFIG.SYSTEM_INIT_MESSAGE};
  let history = [];
  try {
    history = await DATABASE.get(key).then((res) => JSON.parse(res));
  } catch (e) {
    console.error(e);
  }
  if (!history || !Array.isArray(history) || history.length === 0) {
    history = [];
  }
  if (ENV.AUTO_TRIM_HISTORY && ENV.MAX_HISTORY_LENGTH > 0) {
    // 历史记录超出长度需要裁剪
    if (history.length > ENV.MAX_HISTORY_LENGTH) {
      history = history.splice(history.length - ENV.MAX_HISTORY_LENGTH);
    }
    // 处理token长度问题
    let tokenLength = ENV.DISABLE_SYSTEM_INIT_MESSAGE ? 0 : Array.from(initMessage.content).length;
    for (let i = history.length - 1; i >= 0; i--) {
      const historyItem = history[i];
      let length = 0;
      if (historyItem.content) {
        length = Array.from(historyItem.content).length;
      } else {
        historyItem.content = '';
      }
      // 如果最大长度超过maxToken,裁剪history
      tokenLength += length;
      if (tokenLength > MAX_TOKEN_LENGTH) {
        history = history.splice(i + 1);
        break;
      }
    }
  }
  if (ENV.DISABLE_SYSTEM_INIT_MESSAGE) {
    switch (history.length > 0 ? history[0].role : '') {
      case 'assistant': // 第一条为机器人，替换成init
      case 'system': // 第一条为system，用新的init替换
        history[0] = initMessage;
        break;
      default:// 默认给第一条插入init
        history.unshift(initMessage);
    }
  } else if (history.length > 0 && history[0].role === 'system') {
    // 如果禁用 system init message 且第一条消息为 system，去掉这条消息
    history.shift()
  }
  return {real: history};
}

export async function handleMessage(request) {
  const {message} = await request.json();

  // 消息处理中间件
  const handlers = [
    msgInitTelegramToken, // 初始化token
    msgInitChatContext, // 初始化聊天上下文: 生成chat_id, reply_to_message_id(群组消息), SHARE_CONTEXT
    msgSaveLastMessage, // 保存最后一条消息
    msgCheckEnvIsReady, // 检查环境是否准备好: API_KEY, DATABASE
    processMessageByChatType, // 根据类型对消息进一步处理
    msgChatWithOpenAI, // 与OpenAI聊天
  ];

  for (const handler of handlers) {
    try {
      const result = await handler(message, request);
      if (result && result instanceof Response) {
        return result;
      }
    } catch (e) {
      return new Response(errorToString(e), {status: 200});
    }
  }
  return null;
}
