import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { buildExpansionPrompt } from './prompts/expansionPrompt.js';
import { buildPlanningPrompt } from './prompts/planningPrompt.js';
import { buildCodeGenerationPrompt } from './prompts/codeGenerationPrompt.js';
import { buildGenerationRepairPrompt } from './prompts/generationRepairPrompt.js';
import { buildEditPrompt } from './prompts/editPrompt.js';
import { buildExplainPrompt } from './prompts/explainPrompt.js';
import { buildRetryPrompt } from './prompts/retryPrompt.js';
import { parseStructuredResponse, validateBlueprint, validateExpansionSpec } from './parseStructuredResponse.js';
import { withCallLog } from '../observability/centralCallLogger.js';
import { getTaskLlmConfig } from '../../config/taskLlmConfig.js';
import { fetchLlmResponse } from './llmTransport.js';

const AgentState = Annotation.Root({
  task: Annotation(),
  project: Annotation(),
  prompt: Annotation(),
  imageDescription: Annotation(),
  specification: Annotation(),
  clarification: Annotation(),
  blueprint: Annotation(),
  previousFiles: Annotation(),
  targetFiles: Annotation(),
  contracts: Annotation(),
  warnings: Annotation(),
  agentName: Annotation(),
  phase: Annotation(),
  dependencyContext: Annotation(),
  message: Annotation(),
  fallbackResult: Annotation(),
  validationError: Annotation(),
  generatedFiles: Annotation(),
  attempt: Annotation(),
  graphSummary: Annotation(),
  fallbackExplanation: Annotation(),
  onToken: Annotation(),
  result: Annotation()
});

const expansionGraph = new StateGraph(AgentState)
  .addNode('expansion_agent', expansionNode)
  .addEdge(START, 'expansion_agent')
  .addEdge('expansion_agent', END)
  .compile();

const planningGraph = new StateGraph(AgentState)
  .addNode('planning_agent', planningNode)
  .addEdge(START, 'planning_agent')
  .addEdge('planning_agent', END)
  .compile();

const codeGenerationGraph = new StateGraph(AgentState)
  .addNode('code_generation_agent', codeGenerationNode)
  .addEdge(START, 'code_generation_agent')
  .addEdge('code_generation_agent', END)
  .compile();

const editGraph = new StateGraph(AgentState)
  .addNode('edit_agent', editNode)
  .addEdge(START, 'edit_agent')
  .addEdge('edit_agent', END)
  .compile();

const generationRepairGraph = new StateGraph(AgentState)
  .addNode('generation_repair_agent', generationRepairNode)
  .addEdge(START, 'generation_repair_agent')
  .addEdge('generation_repair_agent', END)
  .compile();

const explainGraph = new StateGraph(AgentState)
  .addNode('explain_agent', explainNode)
  .addEdge(START, 'explain_agent')
  .addEdge('explain_agent', END)
  .compile();

export async function runExpansionGraph({ prompt, imageDescription, fallback, onToken }) {
  return runAgentGraph('expansion', expansionGraph, {
    task: 'expansion',
    prompt,
    imageDescription,
    fallbackResult: fallback,
    onToken
  });
}

export async function runPlanningGraph({ specification, clarification, fallback, onToken }) {
  return runAgentGraph('planning', planningGraph, {
    task: 'planning',
    specification,
    clarification,
    fallbackResult: fallback,
    onToken
  });
}

export async function runEditGraph({ project, message, targetFiles, dependencyContext, fallback }) {
  return runAgentGraph('edit', editGraph, {
    task: 'edit',
    project,
    message,
    targetFiles,
    dependencyContext,
    fallbackResult: fallback
  });
}

export async function runExplainGraph({ question, graphSummary, fallback }) {
  return runAgentGraph('explain', explainGraph, {
    task: 'explain',
    message: question,
    graphSummary,
    fallbackExplanation: fallback,
    fallbackResult: fallback
  });
}

export async function runGenerationRepairGraph({ specification, blueprint, previousFiles, targetFiles, generatedFiles, validationError, contracts, warnings, fallback, agentName, phase, dependencyContext, attempt }) {
  return runAgentGraph('generation_repair', generationRepairGraph, {
    task: 'generation_repair',
    specification,
    blueprint,
    previousFiles,
    targetFiles,
    generatedFiles,
    validationError,
    contracts,
    warnings,
    agentName,
    phase,
    dependencyContext,
    attempt,
    fallbackResult: fallback
  });
}

export async function runCodeGenerationGraph({ specification, blueprint, previousFiles, targetFiles, contracts, warnings, fallback, agentName, phase, dependencyContext }) {
  return runAgentGraph('code_generation', codeGenerationGraph, {
    task: 'code_generation',
    specification,
    blueprint,
    previousFiles,
    targetFiles,
    contracts,
    warnings,
    agentName,
    phase,
    dependencyContext,
    fallbackResult: fallback
  });
}

async function runAgentGraph(operation, graph, state) {
  return withCallLog({
    type: 'agent_call', operation, provider: 'langgraph',
    metadata: { task: state.task, agentName: state.agentName, phase: state.phase, attempt: state.attempt }
  }, async ({ callId }) => {
    const result = await graph.invoke({ ...state, parentCallId: callId });
    return result.result;
  });
}

async function expansionNode(state) {
  const prompt = buildExpansionPrompt({ prompt: state.prompt, imageDescription: state.imageDescription });
  const result = await callStructuredAgent({
    operation: 'expansion',
    prompt,
    fallbackResult: state.fallbackResult,
    validator: validateExpansionSpec,
    onToken: state.onToken
  });
  return { result };
}

async function planningNode(state) {
  const prompt = buildPlanningPrompt({ specification: state.specification, clarification: state.clarification });
  const result = await callStructuredAgent({
    operation: 'planning',
    prompt,
    fallbackResult: state.fallbackResult,
    validator: validateBlueprint,
    onToken: state.onToken
  });
  return { result };
}

async function editNode(state) {
  const prompt = buildEditPrompt({
    project: state.project,
    message: state.message,
    targetFiles: state.targetFiles,
    dependencyContext: state.dependencyContext
  });
  const result = await callStructuredAgent({
    operation: 'edit',
    prompt,
    fallbackResult: state.fallbackResult,
    validator: validateEditResponse
  });
  return { result };
}

async function explainNode(state) {
  const prompt = buildExplainPrompt({
    question: state.message,
    graphSummary: state.graphSummary,
    fallbackExplanation: state.fallbackExplanation
  });
  const result = await callStructuredAgent({
    operation: 'explain',
    prompt,
    fallbackResult: state.fallbackResult,
    validator: validateExplainResponse
  });
  return { result };
}

async function generationRepairNode(state) {
  const prompt = buildGenerationRepairPrompt({
    specification: state.specification,
    blueprint: state.blueprint,
    previousFiles: state.previousFiles,
    targetFiles: state.targetFiles,
    generatedFiles: state.generatedFiles,
    validationError: state.validationError,
    contracts: state.contracts,
    warnings: state.warnings,
    agentName: state.agentName,
    phase: state.phase,
    dependencyContext: state.dependencyContext,
    attempt: state.attempt
  });
  const result = await callStructuredAgent({
    operation: 'generation_repair',
    prompt,
    fallbackResult: state.fallbackResult,
    validator: validateCodeGenerationResponse
  });
  return { result };
}

async function codeGenerationNode(state) {
  const prompt = buildCodeGenerationPrompt({
    specification: state.specification,
    blueprint: state.blueprint,
    previousFiles: state.previousFiles,
    targetFiles: state.targetFiles,
    contracts: state.contracts,
    warnings: state.warnings,
    agentName: state.agentName,
    phase: state.phase,
    dependencyContext: state.dependencyContext
  });
  const result = await callStructuredAgent({
    operation: 'code_generation',
    prompt,
    fallbackResult: state.fallbackResult,
    validator: validateCodeGenerationResponse
  });
  return { result };
}

async function callStructuredAgent({ operation, prompt, fallbackResult, validator, onToken }) {
  const config = getTaskLlmConfig(operation);
  const { provider } = config;
  let attemptPrompt = prompt;
  for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
    try {
      const raw = await withCallLog({
        type: 'ai_call', operation, provider,
        model: provider === 'openai' ? config.model : 'local-fallback',
        metadata: { attempt, streaming: Boolean(onToken), promptLength: attemptPrompt.length, temperature: config.temperature }
      }, () => provider === 'openai' ? callOpenAI(attemptPrompt, config, { onToken }) : JSON.stringify(fallbackResult));
      if (provider !== 'openai' && onToken) onToken(raw);
      return parseStructuredResponse(raw, validator);
    } catch (error) {
      console.warn('LangGraph structured agent output failed', { operation, attempt, message: error.message });
      attemptPrompt = buildRetryPrompt(prompt, error);
      if (attempt === config.maxRetries) {
        if (fallbackResult) {
          console.warn('LangGraph agent exhausted retries; using validated local fallback', { operation, message: error.message });
          const fallbackValidation = validator(fallbackResult);
          if (fallbackValidation.valid) return fallbackResult;
        }
        throw error;
      }
    }
  }
}

async function callOpenAI(prompt, config, { onToken } = {}) {
  const response = await fetchLlmResponse(config, { input: prompt, stream: Boolean(onToken) });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error?.message || 'OpenAI request failed');
  }
  if (onToken) return readOpenAIStream(response, onToken);
  const data = await response.json();
  return data.output_text || data.output?.flatMap((item) => item.content || []).map((part) => part.text).join('\n');
}

async function readOpenAIStream(response, onToken) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        const event = JSON.parse(payload);
        const delta = event.delta || event.text || event?.item?.content?.[0]?.text || '';
        if (event.type === 'response.output_text.delta' && delta) {
          output += delta;
          onToken(delta);
        }
        if (event.type === 'response.completed') {
          const finalText = event.response?.output_text || event.response?.output?.flatMap((item) => item.content || []).map((content) => content.text || '').join('\n');
          if (finalText && finalText.length > output.length) {
            const tail = finalText.slice(output.length);
            output = finalText;
            onToken(tail);
          }
        }
      }
    }
  }
  return output;
}

function validateCodeGenerationResponse(value) {
  if (!value || !Array.isArray(value.files)) return { valid: false, message: 'files must be an array' };
  for (const file of value.files) {
    if (!file.path || typeof file.path !== 'string') return { valid: false, message: 'file.path is required' };
    if (!file.language || typeof file.language !== 'string') return { valid: false, message: 'file.language is required' };
    if (typeof file.content !== 'string') return { valid: false, message: 'file.content must be a string' };
    // CSS, JSON config, and other non-JS files can legitimately have minimal/empty content.
    // Only enforce non-empty for JS/JSX files.
    const isJsFile = /\.(js|jsx|ts|tsx)$/.test(file.path);
    if (isJsFile && file.content.trim().length === 0) {
      return { valid: false, message: 'file.content is required for JS/JSX file: ' + file.path };
    }
  }
  if (!Array.isArray(value.contracts)) return { valid: false, message: 'contracts must be an array' };
  if (!Array.isArray(value.warnings)) return { valid: false, message: 'warnings must be an array' };
  return { valid: true };
}

function validateEditResponse(value) {
  if (!value || !Array.isArray(value.changes)) return { valid: false, message: 'changes must be an array' };
  for (const change of value.changes) {
    if (!change.path || typeof change.path !== 'string') return { valid: false, message: 'change.path is required' };
    const operation = change.operation || change.changeType || 'update';
    if (operation !== 'delete' && (typeof change.content !== 'string' || change.content.length === 0)) return { valid: false, message: 'change.content is required' };
  }
  if (!Array.isArray(value.warnings)) return { valid: false, message: 'warnings must be an array' };
  return { valid: true };
}

function validateExplainResponse(value) {
  if (!value || typeof value !== 'object') return { valid: false, message: 'explanation must be an object' };
  if (typeof value.title !== 'string') return { valid: false, message: 'title is required' };
  if (typeof value.directAnswer !== 'string') return { valid: false, message: 'directAnswer is required' };
  if (!Array.isArray(value.flow)) return { valid: false, message: 'flow must be an array' };
  if (!Array.isArray(value.importantFiles)) return { valid: false, message: 'importantFiles must be an array' };
  return { valid: true };
}
