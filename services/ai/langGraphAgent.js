import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { buildExpansionPrompt } from './prompts/expansionPrompt.js';
import { buildPlanningPrompt } from './prompts/planningPrompt.js';
import { buildCodeGenerationPrompt } from './prompts/codeGenerationPrompt.js';
import { buildGenerationRepairPrompt } from './prompts/generationRepairPrompt.js';
import { buildEditPrompt } from './prompts/editPrompt.js';
import { parseStructuredResponse, validateBlueprint, validateExpansionSpec } from './parseStructuredResponse.js';

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

export async function runExpansionGraph({ prompt, imageDescription, fallback, onToken }) {
  const state = await expansionGraph.invoke({
    task: 'expansion',
    prompt,
    imageDescription,
    fallbackResult: fallback,
    onToken
  });
  return state.result;
}

export async function runPlanningGraph({ specification, clarification, fallback, onToken }) {
  const state = await planningGraph.invoke({
    task: 'planning',
    specification,
    clarification,
    fallbackResult: fallback,
    onToken
  });
  return state.result;
}

export async function runEditGraph({ project, message, targetFiles, dependencyContext, fallback }) {
  const state = await editGraph.invoke({
    task: 'edit',
    project,
    message,
    targetFiles,
    dependencyContext,
    fallbackResult: fallback
  });
  return state.result;
}

export async function runGenerationRepairGraph({ specification, blueprint, previousFiles, targetFiles, generatedFiles, validationError, contracts, warnings, fallback, agentName, phase, dependencyContext, attempt }) {
  const state = await generationRepairGraph.invoke({
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
  return state.result;
}

export async function runCodeGenerationGraph({ specification, blueprint, previousFiles, targetFiles, contracts, warnings, fallback, agentName, phase, dependencyContext }) {
  const state = await codeGenerationGraph.invoke({
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
  return state.result;
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
  const provider = process.env.AI_PROVIDER || 'mock';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const raw = provider === 'openai' ? await callOpenAI(prompt, { onToken }) : JSON.stringify(fallbackResult);
      if (provider !== 'openai' && onToken) onToken(raw);
      return parseStructuredResponse(raw, validator);
    } catch (error) {
      console.warn('LangGraph structured agent output failed', { operation, attempt, message: error.message });
      if (attempt === 2) {
        if ((operation === 'code_generation' || operation === 'generation_repair' || operation === 'edit') && fallbackResult) return fallbackResult;
        throw error;
      }
    }
  }
}

async function callOpenAI(prompt, { onToken } = {}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required when AI_PROVIDER=openai.');
  }
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.OPENAI_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      input: prompt,
      stream: Boolean(onToken)
    })
  });
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
    if (typeof file.content !== 'string' || file.content.length === 0) return { valid: false, message: 'file.content is required' };
  }
  if (!Array.isArray(value.contracts)) return { valid: false, message: 'contracts must be an array' };
  if (!Array.isArray(value.warnings)) return { valid: false, message: 'warnings must be an array' };
  return { valid: true };
}

function validateEditResponse(value) {
  if (!value || !Array.isArray(value.changes)) return { valid: false, message: 'changes must be an array' };
  for (const change of value.changes) {
    if (!change.path || typeof change.path !== 'string') return { valid: false, message: 'change.path is required' };
    if (typeof change.content !== 'string' || change.content.length === 0) return { valid: false, message: 'change.content is required' };
  }
  if (!Array.isArray(value.warnings)) return { valid: false, message: 'warnings must be an array' };
  return { valid: true };
}
