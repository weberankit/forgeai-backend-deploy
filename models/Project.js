import mongoose from 'mongoose';

const generatedFileSchema = new mongoose.Schema(
  {
    path: { type: String, required: true },
    language: { type: String, required: true },
    content: { type: String, required: true },
    version: { type: Number, default: 1 },
    generatedAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    lastOperation: { type: String, default: 'generate' },
    lastOperationId: { type: String, default: '' }
  },
  { _id: false }
);

const projectSnapshotSchema = new mongoose.Schema(
  {
    snapshotId: { type: String, required: true },
    operationType: { type: String, required: true },
    message: { type: String, default: '' },
    files: { type: [generatedFileSchema], default: [] },
    createdAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const reviewFindingSchema = new mongoose.Schema(
  {
    id: String,
    severity: String,
    category: String,
    title: String,
    description: String,
    file: { type: String, default: null },
    relatedFiles: { type: [String], default: [] },
    rootCause: String,
    recommendedChange: String,
    verification: { type: [String], default: [] }
  },
  { _id: false }
);

const reviewRunSchema = new mongoose.Schema(
  {
    reviewId: { type: String, required: true },
    attempt: { type: Number, default: 1 },
    status: { type: String, enum: ['passed', 'failed', 'escalated'], default: 'failed' },
    summary: { type: mongoose.Schema.Types.Mixed, default: {} },
    findings: { type: [reviewFindingSchema], default: [] },
    filesNeedingChanges: { type: [String], default: [] },
    verificationCommands: { type: [String], default: [] },
    staticValidation: { type: mongoose.Schema.Types.Mixed, default: {} },
    runtimeOutput: { type: String, default: '' },
    fixChanges: { type: [mongoose.Schema.Types.Mixed], default: [] },
    verificationResult: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const deploymentSchema = new mongoose.Schema(
  {
    deploymentId: { type: String, required: true },
    provider: { type: String, default: 'mock' },
    status: { type: String, enum: ['validating', 'building', 'uploading', 'deploying', 'ready', 'failed'], default: 'validating' },
    url: { type: String, default: '' },
    error: { type: String, default: '' },
    demoMode: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const verifiedFixSchema = new mongoose.Schema(
  {
    pattern: String,
    context: String,
    errorMessage: String,
    affectedTechnologies: { type: [String], default: [] },
    fixSummary: String,
    changedFiles: { type: [String], default: [] },
    verified: { type: Boolean, default: true },
    projectId: String,
    createdAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const projectSchema = new mongoose.Schema(
  {
    projectId: { type: String, required: true, unique: true, index: true },
    chatId: { type: String, required: true, index: true },
    visitorId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    originalPrompt: { type: String, required: true },
    imageMetadata: { type: mongoose.Schema.Types.Mixed, default: null },
    websiteReference: { type: mongoose.Schema.Types.Mixed, default: null },
    expandedSpec: { type: mongoose.Schema.Types.Mixed, default: null },
    blueprint: { type: mongoose.Schema.Types.Mixed, default: null },
    generatedFiles: { type: [generatedFileSchema], default: [] },
    dependencyGraph: { type: mongoose.Schema.Types.Mixed, default: {} },
    generationManifest: { type: mongoose.Schema.Types.Mixed, default: null },
    generationDiagnostics: { type: [mongoose.Schema.Types.Mixed], default: [] },
    lastValidProjectFiles: { type: [generatedFileSchema], default: [] },
    reviewHistory: { type: [reviewRunSchema], default: [] },
    fileSnapshots: { type: [projectSnapshotSchema], default: [] },
    verifiedFixCandidates: { type: [verifiedFixSchema], default: [] },
    deployments: { type: [deploymentSchema], default: [] },
    lastExplanation: { type: mongoose.Schema.Types.Mixed, default: null },
    operationStatus: { type: String, default: 'idle' },
    lastChangedFiles: { type: [String], default: [] },
    lastEditMessage: { type: String, default: '' },
    generationStatus: {
      type: String,
      enum: ['not_started', 'preparing', 'generating_batch', 'validating', 'storing', 'ready_for_preview', 'failed'],
      default: 'not_started'
    },
    currentBatch: { type: Number, default: 0 },
    generationProgress: { type: Number, default: 0 },
    generationWarnings: { type: [String], default: [] },
    failedBatch: { type: Number, default: null },
    generationError: { type: String, default: '' },
    lastSuccessfulPreviewAt: { type: Date, default: null },
    approvalStatus: {
      type: String,
      enum: ['draft', 'approved', 'changes_requested'],
      default: 'draft'
    },
    clarification: { type: String, default: '' },
    status: { type: String, enum: ['spec_ready', 'planned', 'approved', 'changes_requested'], default: 'spec_ready' }
  },
  { timestamps: true }
);

export const Project = mongoose.model('Project', projectSchema);
