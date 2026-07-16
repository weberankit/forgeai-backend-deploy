import { randomUUID } from 'crypto';
import { Chat } from '../models/Chat.js';
import { Project } from '../models/Project.js';
import { httpError } from '../utils/httpError.js';

function serializeChat(chat) {
  return chat.toObject({ versionKey: false });
}

export async function createChat(req, res, next) {
  try {
    const chat = await Chat.create({
      chatId: randomUUID(),
      visitorId: req.visitorId,
      title: 'Untitled project',
      messages: [
        {
          messageId: randomUUID(),
          role: 'system',
          type: 'status',
          content: 'New project chat created.',
          metadata: {}
        }
      ]
    });
    res.status(201).json({ chat: serializeChat(chat) });
  } catch (error) {
    next(error);
  }
}

export async function listChats(req, res, next) {
  try {
    const chats = await Chat.find({ visitorId: req.visitorId })
      .sort({ updatedAt: -1 })
      .select('chatId title createdAt updatedAt messages')
      .lean();
    res.json({ chats });
  } catch (error) {
    next(error);
  }
}

export async function getChat(req, res, next) {
  try {
    const chat = await Chat.findOne({ chatId: req.params.chatId, visitorId: req.visitorId });
    if (!chat) throw httpError(404, 'Chat not found.');
    const project = await Project.findOne({ chatId: req.params.chatId, visitorId: req.visitorId }).sort({ updatedAt: -1 }).lean();
    res.json({ chat: serializeChat(chat), project });
  } catch (error) {
    next(error);
  }
}

export async function addMessage(req, res, next) {
  try {
    const content = String(req.body.content || '').trim();
    if (content.length < 1) throw httpError(400, 'Message content is required.');

    const chat = await Chat.findOne({ chatId: req.params.chatId, visitorId: req.visitorId });
    if (!chat) throw httpError(404, 'Chat not found.');

    chat.messages.push({
      messageId: randomUUID(),
      role: 'user',
      type: 'text',
      content,
      metadata: req.body.metadata || {}
    });
    if (chat.title === 'Untitled project') {
      chat.title = content.slice(0, 70);
    }
    await chat.save();
    res.status(201).json({ chat: serializeChat(chat) });
  } catch (error) {
    next(error);
  }
}
