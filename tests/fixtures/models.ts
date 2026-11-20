/** Trimmed /models responses shaped like the real providers' (OpenRouter sampled 2026-11-20). */

export const openrouterModels = {
  data: [
    {
      id: 'inclusionai/ling-3.2-flash:free',
      name: 'inclusionAI: Ling 3.2 Flash (free)',
      context_length: 1048576,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      pricing: { prompt: '0', completion: '0' },
      top_provider: { max_completion_tokens: 262144 },
      supported_parameters: ['max_tokens', 'reasoning', 'response_format', 'tool_choice', 'tools']
    },
    {
      id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      name: 'NVIDIA: Nemotron 3 Ultra (free)',
      context_length: 1000000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { prompt: '0', completion: '0' },
      top_provider: { max_completion_tokens: null },
      supported_parameters: ['tools', 'tool_choice']
    },
    {
      id: 'google/lyria-3-clip-preview',
      name: 'Google: Lyria 3 Clip',
      context_length: 1048576,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text', 'audio'] },
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: ['max_tokens']
    },
    {
      id: 'openrouter/free',
      name: 'Free Models Router',
      context_length: 200000,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: ['tools', 'reasoning']
    },
    {
      id: 'anthropic/claude-fable-5.2',
      name: 'Anthropic: Claude Fable 5.2',
      context_length: 1000000,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      pricing: { prompt: '0.000008', completion: '0.00004' },
      supported_parameters: ['tools']
    },
    {
      id: 'meta-llama/llama-3.3-70b-instruct:free',
      name: 'Meta: Llama 3.3 70B Instruct (free)',
      context_length: 65536,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: ['tools']
    }
  ]
}

export const groqModels = {
  object: 'list',
  data: [
    { id: 'llama-3.3-70b-versatile', object: 'model', active: true, context_window: 131072, max_completion_tokens: 32768 },
    { id: 'openai/gpt-oss-120b', object: 'model', active: true, context_window: 131072, max_completion_tokens: 65536 },
    { id: 'whisper-large-v3', object: 'model', active: true, context_window: 448 },
    { id: 'meta-llama/llama-guard-4-12b', object: 'model', active: true, context_window: 131072 },
    { id: 'old-model-8b', object: 'model', active: false, context_window: 8192 }
  ]
}

export const geminiModels = {
  models: [
    {
      name: 'models/gemini-2.5-flash',
      displayName: 'Gemini 2.5 Flash',
      inputTokenLimit: 1048576,
      outputTokenLimit: 65536,
      supportedGenerationMethods: ['generateContent', 'countTokens'],
      thinking: true
    },
    {
      name: 'models/gemini-embedding-001',
      displayName: 'Gemini Embedding 001',
      inputTokenLimit: 2048,
      supportedGenerationMethods: ['embedContent']
    },
    {
      name: 'models/gemini-2.5-flash-preview-tts',
      displayName: 'Gemini 2.5 Flash TTS',
      supportedGenerationMethods: ['generateContent']
    },
    {
      name: 'models/some-predict-only',
      displayName: 'Predict only',
      supportedGenerationMethods: ['predict']
    }
  ]
}

export const cerebrasModels = {
  object: 'list',
  data: [
    { id: 'gpt-oss-120b', object: 'model', owned_by: 'Cerebras' },
    { id: 'llama3.1-8b', object: 'model', owned_by: 'Cerebras' }
  ]
}

export const mistralModels = {
  object: 'list',
  data: [
    {
      id: 'mistral-large-latest',
      name: 'mistral-large-2411',
      max_context_length: 131072,
      capabilities: { completion_chat: true, function_calling: true, vision: false }
    },
    {
      id: 'codestral-latest',
      name: 'codestral-2508',
      max_context_length: 256000,
      capabilities: { completion_chat: true, function_calling: true, vision: false }
    },
    { id: 'mistral-embed', max_context_length: 8192, capabilities: { completion_chat: false } },
    {
      id: 'mistral-ocr-latest',
      max_context_length: 32768,
      capabilities: { completion_chat: true, function_calling: false }
    }
  ]
}
