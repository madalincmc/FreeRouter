import { ComingIn, Page } from '../components/ui'

export function ModelsScreen() {
  return (
    <Page title="Models" subtitle="Live registry of free models, their health and remaining quota.">
      <ComingIn milestone="M2 – Registry">
        Provider /models sync, free-model detection, status, latency and quota per model, with filters and
        &ldquo;test now&rdquo;.
      </ComingIn>
    </Page>
  )
}
