import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { buildExpansionPrompt } from './prompts/expansionPrompt.js';
import { buildPlanningPrompt } from './prompts/planningPrompt.js';
import { buildCodeGenerationPrompt } from './prompts/codeGenerationPrompt.js';
import { parseStructuredResponse, validateBlueprint, validateExpansionSpec } from './parseStructuredResponse.js';

const AgentState = Annotation.Root({
  task: Annotation(),
  prompt: Annotation(),
  imageDescription: Annotation(),
  specification: Annotation(),
  clarification: Annotation(),
  blueprint: Annotation(),
  previousFiles: Annotation(),
  targetFiles: Annotation(),
  contracts: Annotation(),
  warnings: Annotation(),
  fallbackResult: Annotation(),
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

export async function runExpansionGraph({ prompt, imageDescription, fallback }) {
  const state = await expansionGraph.invoke({
    task: 'expansion',
    prompt,
    imageDescription,
    fallbackResult: fallback
  });
  return state.result;
}

export async function runPlanningGraph({ specification, clarification, fallback }) {
  const state = await planningGraph.invoke({
    task: 'planning',
    specification,
    clarification,
    fallbackResult: fallback
  });
  return state.result;
}

export async function runCodeGenerationGraph({ specification, blueprint, previousFiles, targetFiles, contracts, warnings, fallback }) {
  const state = await codeGenerationGraph.invoke({
    task: 'code_generation',
    specification,
    blueprint,
    previousFiles,
    targetFiles,
    contracts,
    warnings,
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
    validator: validateExpansionSpec
  });
  return { result };
}

async function planningNode(state) {
  const prompt = buildPlanningPrompt({ specification: state.specification, clarification: state.clarification });
  const result = await callStructuredAgent({
    operation: 'planning',
    prompt,
    fallbackResult: state.fallbackResult,
    validator: validateBlueprint
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
    warnings: state.warnings
  });
  const result = await callStructuredAgent({
    operation: 'code_generation',
    prompt,
    fallbackResult: state.fallbackResult,
    validator: validateCodeGenerationResponse
  });
  return { result };
}

async function callStructuredAgent({ operation, prompt, fallbackResult, validator }) {
  const provider = process.env.AI_PROVIDER || 'mock';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const raw = provider === 'openai' ? await callOpenAI(prompt) : JSON.stringify(fallbackResult);
      return parseStructuredResponse(raw, validator);
    } catch (error) {
      console.warn('LangGraph structured agent output failed', { operation, attempt, message: error.message });
      if (attempt === 2) throw error;
    }
  }
}

async function callOpenAI(prompt) {
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
      input: prompt
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'OpenAI request failed');
  return data.output_text || data.output?.flatMap((item) => item.content || []).map((part) => part.text).join('\n');
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
