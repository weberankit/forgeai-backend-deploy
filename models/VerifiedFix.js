import mongoose from 'mongoose';

const verifiedFixSchema = new mongoose.Schema(
  {
    fixId: { type: String, required: true, unique: true, index: true },
    pattern: { type: String, required: true, index: true },
    context: { type: String, default: '' },
    errorSignature: { type: String, default: '', index: true },
    errorCategory: { type: String, default: '', index: true },
    technologies: { type: [String], default: [] },
    fixSummary: { type: String, default: '' },
    changedFileTypes: { type: [String], default: [] },
    verificationEvidence: { type: [String], default: [] },
    verified: { type: Boolean, default: true, index: true },
    projectId: { type: String, required: true, index: true },
    scope: { type: String, enum: ['global'], default: 'global', index: true }
  },
  { timestamps: true }
);

export const VerifiedFix = mongoose.model('VerifiedFix', verifiedFixSchema);
