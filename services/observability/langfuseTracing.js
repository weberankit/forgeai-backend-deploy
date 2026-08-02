import { propagateAttributes, startActiveObservation } from '@langfuse/tracing';

const noOpTelemetry = Object.freeze({
  recordUsage() {},
  recordEvent() {},
  recordOutcome() {}
});

export function langfuseTracingEnabled() {
  return process.env.LANGFUSE_ENABLED !== 'false'
    && Boolean(process.env.LANGFUSE_PUBLIC_KEY)
    && Boolean(process.env.LANGFUSE_SECRET_KEY);
}

export function buildProjectTraceContext({ projectId, operation, qualityMode, metadata = {} } = {}) {
  const normalizedProjectId = cleanAttribute(projectId);
  const normalizedOperation = cleanAttribute(operation || 'project_operation');
  return {
    ...(normalizedProjectId ? { sessionId: 'project:' + normalizedProjectId } : {}),
    traceName: 'forgeai.' + normalizedOperation,
    metadata: stringMetadata({
      projectId: normalizedProjectId,
      operation: normalizedOperation,
      qualityMode,
      ...metadata
    }),
    tags: ['forgeai', normalizedOperation].filter(Boolean)
  };
}

export async function withLangfuseProjectContext(context, callback) {
  if (!langfuseTracingEnabled()) return callback();
  let callbackStarted = false;
  let callbackCompleted = false;
  let callbackResult;
  let pipelineError;
  try {
    return await propagateAttributes(buildProjectTraceContext(context), async () => {
      callbackStarted = true;
      try {
        callbackResult = await callback();
        callbackCompleted = true;
        return callbackResult;
      } catch (error) {
        pipelineError = error;
        throw error;
      }
    });
  } catch (error) {
    if (pipelineError) throw pipelineError;
    console.warn('Langfuse context propagation failed; continuing without telemetry', { message: error?.message || String(error) });
    if (callbackCompleted) return callbackResult;
    if (!callbackStarted) return callback();
    throw error;
  }
}

export async function withLangfuseObservation({ type, operation, provider, model, metadata, input }, callback) {
  if (!langfuseTracingEnabled()) return callback(noOpTelemetry);

  const asType = type === 'ai_call' ? 'generation' : type === 'agent_call' ? 'agent' : 'span';
  const attributes = {
    input,
    metadata: {
      type,
      operation,
      provider,
      ...(metadata || {})
    }
  };
  if (asType === 'generation') {
    attributes.model = model;
    attributes.modelParameters = numericModelParameters(metadata);
  }

  let callbackStarted = false;
  let callbackCompleted = false;
  let callbackResult;
  let pipelineError;
  try {
    return await startActiveObservation('forgeai.' + operation, async (observation) => {
      callbackStarted = true;
      const safeUpdate = (update) => {
        try {
          observation.update(update);
        } catch (error) {
          console.warn('Langfuse observation update skipped', { operation, message: error?.message || String(error) });
        }
      };
      safeUpdate(attributes);
      const telemetry = {
        recordUsage(usage) {
          const usageDetails = normalizeOpenAiUsage(usage);
          if (Object.keys(usageDetails).length) safeUpdate({ usageDetails });
        },
        recordEvent(name, eventMetadata = {}, level = 'DEFAULT') {
          try {
            const event = observation.startObservation('forgeai.' + cleanAttribute(name || 'event'), {
              level,
              metadata: safeTelemetryMetadata(eventMetadata)
            }, { asType: 'event' });
            event.end();
          } catch (error) {
            console.warn('Langfuse event skipped', { operation, message: error?.message || String(error) });
          }
        },
        recordOutcome(status, outcomeMetadata = {}, level = 'DEFAULT') {
          safeUpdate({
            level,
            statusMessage: cleanAttribute(status),
            metadata: safeTelemetryMetadata(outcomeMetadata)
          });
        }
      };

      try {
        callbackResult = await callback(telemetry);
        callbackCompleted = true;
        safeUpdate({ output: callbackResult });
        return callbackResult;
      } catch (error) {
        pipelineError = error;
        safeUpdate({
          level: 'ERROR',
          statusMessage: cleanAttribute(error?.message || error?.name || 'Error')
        });
        throw error;
      }
    }, { asType });
  } catch (error) {
    if (pipelineError) throw pipelineError;
    console.warn('Langfuse observation failed; continuing pipeline without telemetry', { operation, message: error?.message || String(error) });
    if (callbackCompleted) return callbackResult;
    if (!callbackStarted) return callback(noOpTelemetry);
    throw error;
  }
}

export function normalizeOpenAiUsage(usage) {
  if (!usage || typeof usage !== 'object') return {};
  return withoutInvalidNumbers({
    promptTokens: usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokens,
    completionTokens: usage.output_tokens ?? usage.completion_tokens ?? usage.completionTokens,
    totalTokens: usage.total_tokens ?? usage.totalTokens
  });
}

function numericModelParameters(metadata) {
  return withoutInvalidNumbers({
    temperature: metadata?.temperature,
    maxOutputTokens: metadata?.maxOutputTokens,
    attempt: metadata?.attempt
  });
}

function safeTelemetryMetadata(metadata) {
  return Object.fromEntries(Object.entries(metadata || {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 500) : value]));
}

function stringMetadata(metadata) {
  return Object.fromEntries(Object.entries(metadata || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => [String(key).slice(0, 200), cleanAttribute(Array.isArray(value) ? value.join(',') : value)]));
}

function cleanAttribute(value) {
  return String(value ?? '').slice(0, 200);
}

function withoutInvalidNumbers(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => Number.isFinite(value)));
}
