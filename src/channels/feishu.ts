import * as Lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// Tag types for Feishu post rich text
interface PostTag {
  tag: string;
  text?: string;
  style?: string[];
  href?: string;
  language?: string;
}

/**
 * Convert Markdown text to Feishu post rich-text format.
 * Supports: bold, italic, strikethrough, inline code, code blocks, links, headers, lists.
 */
function markdownToPost(md: string): PostTag[][] {
  const lines = md.split('\n');
  const result: PostTag[][] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      result.push([
        {
          tag: 'code_block',
          language: lang || 'plain',
          text: codeLines.join('\n'),
        },
      ]);
      continue;
    }

    // Heading → bold line
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      result.push(parseInline(headingMatch[2], true));
      i++;
      continue;
    }

    // Empty line
    if (!line.trim()) {
      result.push([{ tag: 'text', text: '' }]);
      i++;
      continue;
    }

    // List items: preserve bullet/number prefix, parse inline formatting on the rest
    const listMatch = line.match(/^(\s*[-*]\s+|\s*\d+\.\s+)(.*)/);
    if (listMatch) {
      const prefix = listMatch[1];
      const body = listMatch[2];
      result.push([{ tag: 'text', text: prefix }, ...parseInline(body)]);
      i++;
      continue;
    }

    // Regular line
    result.push(parseInline(line));
    i++;
  }

  return result;
}

/**
 * Parse inline Markdown formatting into Feishu post tags.
 * Handles: **bold**, *italic*, ~~strikethrough~~, `code`, [text](url)
 */
function parseInline(text: string, forceStyle?: boolean): PostTag[] {
  const tags: PostTag[] = [];
  // Regex matches inline patterns in order of precedence
  const re =
    /(\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    // Text before this match
    if (match.index > last) {
      const plain = text.slice(last, match.index);
      if (plain) {
        const t: PostTag = { tag: 'text', text: plain };
        if (forceStyle) t.style = ['bold'];
        tags.push(t);
      }
    }

    if (match[2] !== undefined) {
      // **bold**
      tags.push({ tag: 'text', text: match[2], style: ['bold'] });
    } else if (match[3] !== undefined) {
      // *italic*
      tags.push({ tag: 'text', text: match[3], style: ['italic'] });
    } else if (match[4] !== undefined) {
      // ~~strikethrough~~
      tags.push({ tag: 'text', text: match[4], style: ['lineThrough'] });
    } else if (match[5] !== undefined) {
      // `inline code`
      tags.push({ tag: 'text', text: match[5], style: ['codeInline'] });
    } else if (match[6] !== undefined && match[7] !== undefined) {
      // [text](url)
      tags.push({ tag: 'a', text: match[6], href: match[7] });
    }

    last = match.index + match[0].length;
  }

  // Remaining text
  if (last < text.length) {
    const rest = text.slice(last);
    if (rest) {
      const t: PostTag = { tag: 'text', text: rest };
      if (forceStyle) t.style = ['bold'];
      tags.push(t);
    }
  }

  if (tags.length === 0) {
    const t: PostTag = { tag: 'text', text };
    if (forceStyle) t.style = ['bold'];
    tags.push(t);
  }

  return tags;
}

/**
 * Build a Feishu interactive card payload.
 * Uses the card 2.0 JSON schema with a markdown element for rich content.
 */
function buildInteractiveCard(title: string, content: string): object {
  return {
    schema: '2.0',
    body: {
      elements: [
        ...(title
          ? [
              {
                tag: 'markdown',
                content: `**${title}**`,
              },
            ]
          : []),
        {
          tag: 'markdown',
          content,
        },
      ],
    },
    header: title
      ? {
          title: { tag: 'plain_text', content: title },
        }
      : undefined,
  };
}

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: Lark.Client;
  private wsClient: Lark.WSClient | null = null;
  private opts: FeishuChannelOpts;
  private botOpenId: string = '';
  // Cache chat names to avoid repeated API calls
  private chatNameCache = new Map<string, string>();

  constructor(appId: string, appSecret: string, opts: FeishuChannelOpts) {
    this.client = new Lark.Client({ appId, appSecret });
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Fetch bot info to get our own open_id for mention detection
    try {
      const botInfo: any = await this.client.request({
        method: 'GET',
        url: 'https://open.feishu.cn/open-apis/bot/v3/info',
      });
      this.botOpenId = botInfo?.bot?.open_id || '';
      logger.info({ botOpenId: this.botOpenId }, 'Feishu bot info retrieved');
    } catch (err) {
      logger.warn(
        { err },
        'Failed to get Feishu bot info, mention detection may not work',
      );
    }

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        await this.handleMessage(data);
      },
    });

    const { appId, appSecret } = this.client;

    this.wsClient = new Lark.WSClient({
      appId,
      appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
    });

    await this.wsClient.start({ eventDispatcher });
    logger.info('Feishu bot connected');
    console.log('\n  Feishu bot connected via WebSocket');
    console.log("  Send /chatid to the bot to get a chat's registration ID\n");
  }

  private async handleMessage(data: any): Promise<void> {
    const message = data.message;
    if (!message) return;

    const chatId = message.chat_id;
    const chatType = message.chat_type; // 'group' or 'p2p'
    const msgType = message.message_type;
    const msgId = message.message_id;
    const rawContent = message.content || '{}';
    const mentions: any[] = message.mentions || [];
    const createTime = message.create_time; // millisecond timestamp string

    const chatJid = `feishu:${chatId}`;
    const timestamp = createTime
      ? new Date(parseInt(createTime, 10)).toISOString()
      : new Date().toISOString();

    // Extract sender info
    const senderId = data.sender?.sender_id?.open_id || '';
    const senderName = await this.getSenderName(data.sender, mentions);

    // Determine chat name
    const isGroup = chatType === 'group';
    let chatName: string;
    if (isGroup) {
      chatName = await this.getChatName(chatId);
    } else {
      chatName = senderName;
    }

    // Build content from message type
    let content = this.extractContent(msgType, rawContent, mentions);

    // Check for /chatid and /ping commands (text messages starting with /)
    if (msgType === 'text' && content.startsWith('/')) {
      const cmd = content.split(/\s/)[0].toLowerCase();
      if (cmd === '/chatid') {
        await this.sendMessage(
          chatJid,
          `Chat ID: feishu:${chatId}\nName: ${chatName}\nType: ${chatType}`,
        );
        return;
      }
      if (cmd === '/ping') {
        await this.sendMessage(chatJid, `${ASSISTANT_NAME} is online.`);
        return;
      }
    }

    // Translate @bot mentions into TRIGGER_PATTERN format
    if (this.botOpenId && mentions.length > 0) {
      const isBotMentioned = mentions.some(
        (m: any) => m.id?.open_id === this.botOpenId,
      );
      if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    // Report chat metadata
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'feishu', isGroup);

    // Only deliver full message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Feishu chat',
      );
      return;
    }

    // Deliver message
    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender: senderId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      'Feishu message stored',
    );
  }

  private extractContent(
    msgType: string,
    rawContent: string,
    mentions: any[],
  ): string {
    let parsed: any;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      parsed = {};
    }

    switch (msgType) {
      case 'text': {
        let text: string = parsed.text || '';
        // Replace @mention placeholders (e.g. @_user_1) with display names
        for (const m of mentions) {
          if (m.key && m.name) {
            text = text.replace(m.key, `@${m.name}`);
          }
        }
        return text;
      }
      case 'post':
        return this.extractPostText(parsed);
      case 'image':
        return '[Image]';
      case 'file':
        return `[File: ${parsed.file_name || 'file'}]`;
      case 'audio':
        return '[Audio]';
      case 'media':
        return '[Video]';
      case 'sticker':
        return '[Sticker]';
      case 'interactive':
        return '[Card]';
      case 'share_chat':
        return '[Shared Group]';
      case 'share_user':
        return '[Shared Contact]';
      case 'merge_forward':
        return '[Merge Forward]';
      default:
        return `[Unsupported: ${msgType}]`;
    }
  }

  private extractPostText(parsed: any): string {
    // Post (rich text) content has a nested structure: { title, content: [[{tag,text},...], ...] }
    const lang =
      parsed.zh_cn ||
      parsed.en_us ||
      parsed.ja_jp ||
      (Object.values(parsed)[0] as any);
    if (!lang) return '[Post]';
    const parts: string[] = [];
    if (lang.title) parts.push(lang.title);
    if (Array.isArray(lang.content)) {
      for (const line of lang.content) {
        if (!Array.isArray(line)) continue;
        for (const node of line) {
          if (node.tag === 'text' && node.text) parts.push(node.text);
          else if (node.tag === 'a' && node.text) parts.push(node.text);
          else if (node.tag === 'at' && node.user_name)
            parts.push(`@${node.user_name}`);
          else if (node.tag === 'img') parts.push('[Image]');
          else if (node.tag === 'media') parts.push('[Video]');
        }
      }
    }
    return parts.join(' ') || '[Post]';
  }

  private async getSenderName(sender: any, mentions: any[]): Promise<string> {
    // Try to get name from mentions (if sender mentioned themselves or bot knows)
    const senderId = sender?.sender_id?.open_id;
    if (!senderId) return 'Unknown';

    // Try fetching user info via API
    try {
      const resp = await this.client.contact.v3.user.get({
        path: { user_id: senderId },
        params: { user_id_type: 'open_id' },
      });
      const name = (resp as any)?.data?.user?.name || (resp as any)?.user?.name;
      if (name) return name;
    } catch (err) {
      logger.warn({ err, senderId }, 'Failed to get Feishu user name');
    }

    // Fallback to sender open_id
    return senderId;
  }

  private async getChatName(chatId: string): Promise<string> {
    const cached = this.chatNameCache.get(chatId);
    if (cached) return cached;

    try {
      const resp = await this.client.im.v1.chat.get({
        path: { chat_id: chatId },
      });
      const name = (resp as any)?.data?.name || (resp as any)?.name;
      if (name) {
        this.chatNameCache.set(chatId, name);
        return name;
      }
    } catch {
      // Fall through
    }

    return chatId;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.replace(/^feishu:/, '');
    const post = markdownToPost(text);

    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'post',
          content: JSON.stringify({ zh_cn: { title: '', content: post } }),
        },
      });
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Feishu message');
      return;
    }
    logger.info({ jid, length: text.length }, 'Feishu message sent');
  }

  async sendCard(
    jid: string,
    title: string,
    content: string,
  ): Promise<string | null> {
    const chatId = jid.replace(/^feishu:/, '');
    const card = buildInteractiveCard(title, content);

    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      const messageId = (resp as any)?.data?.message_id || null;
      logger.info({ jid, messageId }, 'Feishu card sent');
      return messageId;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Feishu card');
      return null;
    }
  }

  async updateCard(
    jid: string,
    cardId: string,
    title: string,
    content: string,
  ): Promise<void> {
    const card = buildInteractiveCard(title, content);

    try {
      await this.client.im.v1.message.patch({
        path: { message_id: cardId },
        data: { content: JSON.stringify(card) },
      });
      logger.info({ jid, cardId }, 'Feishu card updated');
    } catch (err) {
      logger.error({ jid, cardId, err }, 'Failed to update Feishu card');
    }
  }

  isConnected(): boolean {
    return this.wsClient !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('feishu:');
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      this.wsClient = null;
      logger.info('Feishu bot stopped');
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Feishu does not support a typing indicator API — no-op
  }
}

registerChannel('feishu', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  const appId = process.env.FEISHU_APP_ID || envVars.FEISHU_APP_ID || '';
  const appSecret =
    process.env.FEISHU_APP_SECRET || envVars.FEISHU_APP_SECRET || '';
  if (!appId || !appSecret) {
    logger.warn('Feishu: FEISHU_APP_ID or FEISHU_APP_SECRET not set');
    return null;
  }
  return new FeishuChannel(appId, appSecret, opts);
});
