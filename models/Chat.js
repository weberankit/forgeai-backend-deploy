import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema(
  {
    messageId: { type: String, required: true },
    role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
    type: {
      type: String,
      enum: ['text', 'specification', 'blueprint', 'clarification', 'status'],
      default: 'text'
    },
    content: { type: mongoose.Schema.Types.Mixed, required: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const chatSchema = new mongoose.Schema(
  {
    chatId: { type: String, required: true, unique: true, index: true },
    visitorId: { type: String, required: true, index: true },
    title: { type: String, default: 'Untitled project' },
    messages: { type: [messageSchema], default: [] }
  },
  { timestamps: true }
);

export const Chat = mongoose.model('Chat', chatSchema);
