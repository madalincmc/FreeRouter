# Terms of use & responsible use

FreeRouter is free, open-source software under the [MIT License](LICENSE). It runs on your computer and talks to
third-party AI providers **using your own accounts and API keys**. This page explains what that means for you.
Please read it before you add your first key.

> **In short:** you are the provider's customer, not us. Read each provider's terms, keep your accounts on their
> free tiers, don't attach payment methods just to unlock a "free" trial, and check your provider dashboards
> regularly.

*This page is general guidance, not legal advice. If something here conflicts with a provider's own terms, the
provider's terms win.*

---

## 1. You agree to each provider's terms, not ours

When FreeRouter sends a request, it sends it to the provider **as you**, with your key. Your use is governed by
that provider's terms of service, acceptable-use policy, privacy policy and rate limits. FreeRouter doesn't change
or override any of them.

Before adding a key, read the provider's terms. In particular, check:

- what the free tier covers, and whether it's meant for testing only or also for production;
- whether prompts on the free tier are logged, reviewed by people or used for training;
- which regions the provider serves and how old you must be;
- what they say about automated access, multiple accounts and sharing keys.

| Provider | Terms | Pricing / limits |
|---|---|---|
| OpenRouter | [openrouter.ai/terms](https://openrouter.ai/terms) · [privacy](https://openrouter.ai/privacy) | [Limits](https://openrouter.ai/docs/api-reference/limits) |
| Groq | [groq.com/terms-of-use](https://groq.com/terms-of-use) | [Pricing](https://groq.com/pricing) · [rate limits](https://console.groq.com/docs/rate-limits) |
| Google Gemini (AI Studio) | [Gemini API terms](https://ai.google.dev/gemini-api/terms) | [Pricing](https://ai.google.dev/gemini-api/docs/pricing) · [billing](https://ai.google.dev/gemini-api/docs/billing) |
| NVIDIA NIM | [NVIDIA terms](https://www.nvidia.com/en-us/about-nvidia/terms-of-service/) + the API trial terms shown on [build.nvidia.com](https://build.nvidia.com/) | [Docs](https://docs.api.nvidia.com/nim/) |
| Cerebras | [cerebras.ai/terms-of-service](https://www.cerebras.ai/terms-of-service) | [Rate limits](https://inference-docs.cerebras.ai/support/rate-limits) |
| Mistral | [mistral.ai/terms](https://mistral.ai/terms) | [Pricing](https://mistral.ai/pricing) |

Providers change their terms. These links were checked in November 2026, so read the current version yourself.

## 2. Costs: "free" is the provider's promise, not ours

FreeRouter only routes to models it detects as free, and it never routes to a model the registry marks as paid.
Free detection is best-effort, though, and some of it rests on assumptions about your account:

- **OpenRouter:** only `:free` models with zero listed pricing are used.
- **Gemini, Groq, NVIDIA, Cerebras and Mistral:** FreeRouter assumes **your whole account is on the free tier**.
  If billing is enabled on that account or Google Cloud project, the same requests may be **charged at paid
  rates**. For example, a Gemini key from a project with Cloud Billing turned on is no longer on the free tier.
- Free tiers, limits and model line-ups change, sometimes without notice. A model that was free yesterday can
  become paid today, and FreeRouter only notices at the next model sync.

What you can do:

- **Use keys from accounts and projects with no billing attached.** This is the single best protection.
- **Check each provider's usage or billing dashboard regularly,** especially after adding a key or a new
  provider.
- If you do have billing enabled anywhere, **set a hard spending limit or budget alert** in that provider's
  console. FreeRouter doesn't track money and can't stop a charge.
- Turn off a provider or key in **Providers & keys** if you're unsure about its costs.

## 3. Don't add a credit card to unlock a "free" trial

Some providers ask for a card, a billing account or a prepaid top-up before they issue an API key, even for a
"free" trial. In November 2026 that included Cerebras and Mistral. Those providers are off by default in
FreeRouter for that reason.

We recommend that you **don't add a payment method just to get free credits.** When a trial ends or its credits
run out, many providers keep serving requests and start charging, and a background tool like FreeRouter can use
a lot of requests without you noticing. Alibaba Cloud Model Studio, for example, bills automatically after its
free quota unless you turn on a "free quota only" setting. If you decide to add a card anyway:

- prefer prepaid credits over automatic billing;
- set the lowest spending cap the provider allows, and turn on alerts;
- remove the card, or close the trial, when you're done.

## 4. Play fair with free tiers

Free tiers exist because providers choose to offer them. Using them in ways the terms forbid can get your
account suspended, and it makes free access worse for everyone.

- **Don't create multiple accounts** to multiply free quotas, unless the provider's terms allow it. FreeRouter's
  support for several keys is meant for keys you're legitimately entitled to (for example, separate projects
  where the provider allows it), not for getting around limits.
- **Don't share, sell or resell access.** The gateway is for you, on your own machine. Don't expose it to the
  internet or let other people use your keys through it. It listens on `127.0.0.1` only for that reason.
- **Respect rate limits.** FreeRouter tracks them and backs off on `429`s, but the provider's limits are the
  ones that count.
- **Check commercial use.** Several free and trial tiers (Cohere's trial keys, for example) don't allow
  production or commercial use.

## 5. Privacy: what you send leaves your machine

- Prompts, files and code you send go to the provider that serves the request. Read their privacy policy.
- **Free tiers often allow logging and training on your prompts.** FreeRouter marks providers it believes may
  do this, and **Private mode** excludes them. These flags reflect our reading of each provider's terms at the
  time, so they can be wrong or out of date.
- Don't send passwords, secrets, personal data about other people, or confidential work material through a free
  tier unless the provider's terms allow it and you're comfortable with them.
- FreeRouter keeps your keys encrypted on your machine (Windows DPAPI) and logs request metadata only, never
  prompts or replies. Your chat history is stored locally in `%APPDATA%\FreeRouter`.

## 6. Your keys are your responsibility

- Treat API keys like passwords. If you think one has leaked, **revoke it in the provider's console** and add a
  new one. Deleting it from FreeRouter doesn't revoke it.
- The gateway token (`fr-local-…`) gives local access to all your providers through FreeRouter. Regenerate it
  from the Gateway screen if it's ever exposed, for example in a screenshot.

## 7. AI output can be wrong

Models make mistakes, invent facts and produce insecure or broken code. FreeRouter may route each request to a
different model, so quality and style can vary between replies. Review output before relying on it, and never run
generated code or commands you don't understand.

## 8. No warranty, no affiliation

- FreeRouter is provided **"as is", without warranty of any kind**, as set out in the [MIT License](LICENSE). The
  authors aren't liable for provider charges, account suspensions, data loss or anything else that results from
  using it.
- FreeRouter isn't affiliated with, endorsed by or sponsored by any provider listed here. Product names and
  trademarks belong to their owners.
- Automatic updates download new versions from this project's GitHub Releases. You can turn them off in
  **Settings → Updates**.
