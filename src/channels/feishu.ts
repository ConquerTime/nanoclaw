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
  private connected = false;
  // Map of chatJid → thinking message ID (for cleanup after agent responds)
  private thinkingMessageIds: Map<string, string> = new Map();

  constructor(appId: string, appSecret: string, opts: FeishuChannelOpts) {
    this.opts = opts;
    this.client = new Lark.Client({ appId, appSecret });
  }

  async connect(): Promise<void> {
    const appId = (this.client as any).appId as string;
    const appSecret = (this.client as any).appSecret as string;

    this.wsClient = new Lark.WSClient({
      appId,
      appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });

    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        logger.info(
          {
            eventType: 'im.message.receive_v1',
            chatId: data?.message?.chat_id,
          },
          'Feishu event received',
        );
        try {
          await this.handleMessage(data);
        } catch (err) {
          logger.error({ err }, 'Feishu message handler error');
        }
      },
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    this.connected = true;

    // Dynamically fetch bot name from Feishu API (informational only)
    // Uses the tokenManager to get tenant_access_token, then calls /bot/v3/info
    try {
      const tokenManager = (this.client as any).tokenManager;
      const token = await tokenManager?.getTenantAccessToken?.();
      if (token) {
        const resp = await fetch(
          'https://open.feishu.cn/open-apis/bot/v3/info',
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        const json = (await resp.json()) as any;
        const botName = json?.bot?.app_name || 'unknown';
        logger.info({ botName }, 'Feishu bot connected via WebSocket');
        console.log(
          `\n  Feishu bot connected (WebSocket long connection) — bot name: "${botName}"\n`,
        );
      } else {
        throw new Error('no token');
      }
    } catch {
      logger.info('Feishu bot connected via WebSocket');
      console.log('\n  Feishu bot connected (WebSocket long connection)\n');
    }
  }

  private async handleMessage(data: any): Promise<void> {
    const msg = data.message;
    if (!msg) return;

    // Only handle text messages
    if (msg.message_type !== 'text') {
      const chatJid = `feishu:${msg.chat_id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;
      const timestamp = new Date(parseInt(msg.create_time)).toISOString();
      const senderOpenId = data.sender?.sender_id?.open_id || '';
      this.opts.onMessage(chatJid, {
        id: msg.message_id,
        chat_jid: chatJid,
        sender: senderOpenId,
        sender_name: senderOpenId,
        content: `[${msg.message_type}]`,
        timestamp,
        is_from_me: false,
      });
      return;
    }

    const chatId = msg.chat_id;
    const chatJid = `feishu:${chatId}`;
    const timestamp = new Date(parseInt(msg.create_time)).toISOString();
    const senderOpenId = data.sender?.sender_id?.open_id || '';

    // Parse text content
    let content = '';
    let mentions: Array<{
      key: string;
      name: string;
      id?: { open_id?: string };
    }> = [];
    try {
      const parsed = JSON.parse(msg.content);
      content = parsed.text || '';
      mentions = parsed.mentions || [];
    } catch {
      content = msg.content || '';
    }

    // Determine chat name from chat type
    const isGroup = msg.chat_type === 'group';
    const chatName = msg.chat_type === 'p2p' ? senderOpenId : chatId;

    // Resolve sender name via API (best effort)
    let senderName = senderOpenId;
    try {
      const userResp = await this.client.contact.user.get({
        params: { user_id_type: 'open_id' },
        path: { user_id: senderOpenId },
      });
      senderName = (userResp as any)?.data?.user?.name || senderOpenId;
    } catch {
      // ignore — use open_id as fallback
    }

    // Log raw content for debugging mention format
    logger.debug(
      { rawContent: msg.content, parsedText: content, mentions },
      'Feishu raw message content',
    );

    // Detect if the bot was @mentioned.
    // Feishu uses @_user_N placeholders in text + a mentions array.
    // Any @_user_ placeholder means someone was mentioned — in a group
    // context the bot is typically the only one that can be @mentioned to
    // trigger it, so we treat any @_user_ as a bot mention.
    // Also handle legacy <at user_id="...">Name</at> XML format.
    const wasMentioned =
      /@_user_\S*/g.test(content) || /<at[^>]*>/g.test(content);

    // Strip the mention placeholders from the display text
    let cleanContent = content
      .replace(/@_user_\S*/g, '')
      .replace(/<at[^>]*>([^<]*)<\/at>/g, '')
      .trim();

    // If bot was mentioned, prepend @AssistantName so TRIGGER_PATTERN matches.
    // This makes trigger detection independent of the bot's display name in Feishu.
    const finalContent = wasMentioned
      ? `@${ASSISTANT_NAME} ${cleanContent}`.trim()
      : cleanContent;

    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'feishu', isGroup);

    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Feishu chat',
      );
      return;
    }

    this.opts.onMessage(chatJid, {
      id: msg.message_id,
      chat_jid: chatJid,
      sender: senderOpenId,
      sender_name: senderName,
      content: finalContent,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      'Feishu message stored',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.replace(/^feishu:/, '');
    const post = markdownToPost(text);

    try {
      await this.client.im.message.create({
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
      const resp = await this.client.im.message.create({
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
      await this.client.im.message.patch({
        path: { message_id: cardId },
        data: { content: JSON.stringify(card) },
      });
      logger.info({ jid, cardId }, 'Feishu card updated');
    } catch (err) {
      logger.error({ jid, cardId, err }, 'Failed to update Feishu card');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('feishu:');
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      // WSClient doesn't expose a stop() method — mark as disconnected
      this.connected = false;
      this.wsClient = null;
      logger.info('Feishu bot disconnected');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const chatId = jid.replace(/^feishu:/, '');
    if (isTyping) {
      try {
        const resp = await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: '⏳ 思考中...' }),
          },
        });
        const messageId = (resp as any)?.data?.message_id;
        if (messageId) {
          this.thinkingMessageIds.set(jid, messageId);
        }
      } catch (err) {
        logger.debug({ jid, err }, 'Failed to send Feishu thinking message');
      }
    } else {
      const messageId = this.thinkingMessageIds.get(jid);
      if (messageId) {
        this.thinkingMessageIds.delete(jid);
        try {
          await (this.client.im.message as any).delete({
            path: { message_id: messageId },
          });
        } catch {
          // Best-effort: if delete fails, just leave it
        }
      }
    }
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
