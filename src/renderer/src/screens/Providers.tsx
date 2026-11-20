import { ComingIn, Page } from '../components/ui'

export function ProvidersScreen() {
  return (
    <Page title="Providers & keys" subtitle="API keys are encrypted with Windows DPAPI and never leave the main process.">
      <ComingIn milestone="M1 – Keys and providers">
        Add, test and delete keys for OpenRouter, Groq, Gemini, Cerebras, Mistral and GitHub Models.
      </ComingIn>
    </Page>
  )
}
