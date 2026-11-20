import { ComingIn, Page } from '../components/ui'

export function ChatScreen() {
  return (
    <Page title="Chat" subtitle="Auto-routed conversations across free models.">
      <ComingIn milestone="M4 – Chat UI">
        Streaming chat with a model badge, model picker (Auto / profile / chain / pinned), regenerate-with and
        conversation history.
      </ComingIn>
    </Page>
  )
}
