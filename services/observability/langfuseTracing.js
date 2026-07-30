import { startActiveObservation } from '@langfuse/tracing';

const noOpTelemetry = Object.freeze({ recordUsage() {} });

export function langfuseTracingEnabled() {
  return process.env.LANGFUSE_ENABLED !== 'false'
    && Boolean(process.env.LANGFUSE_PUBLIC_KEY)
    && Boolean(process.env.LANGFUSE_SECRET_KEY);
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

  return startActiveObservation('forgeai.' + operation, async (observation) => {
    observation.update(attributes);
    const telemetry = {
      recordUsage(usage) {
        const usageDetails = normalizeOpenAiUsage(usage);
        if (Object.keys(usageDetails).length) observation.update({ usageDetails });
      }
    };
    try {
      const result = await callback(telemetry);
      observation.update({ output: result });
      return result;
    } catch (error) {
      observation.update({
        level: 'ERROR',
        statusMessage: error?.name || 'Error'
      });
      throw error;
    }
  }, { asType });
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

function withoutInvalidNumbers(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => Number.isFinite(value)));
}
