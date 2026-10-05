# Vobiz nodes for n8n

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.md)
[![n8n community node](https://img.shields.io/badge/n8n-community%20node-ff6d5a.svg)](https://docs.n8n.io/integrations/community-nodes/)

Bring [Vobiz](https://www.vobiz.ai) voice and WhatsApp into your [n8n](https://n8n.io) workflows. Place calls that speak a message, answer incoming calls, act the moment a call is answered or ends, pull call records and recordings, send and receive WhatsApp messages, and set up sub-accounts for your customers or teams, KYC included, all without writing code or running a server of your own.

**Package:** `@vobiz-ai/n8n-nodes-vobiz`

## Contents

- [What's included](#whats-included)
- [Installation](#installation)
- [Credentials](#credentials)
- [Nodes](#nodes)
- [Quick start: a call that speaks](#quick-start-a-call-that-speaks)
- [Example workflows](#example-workflows)
- [Good to know](#good-to-know)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Compatibility](#compatibility)
- [Development](#development)
- [Support](#support)
- [License](#license)

## What's included

| Node | Type | Use it to |
|---|---|---|
| **Vobiz** | Action | Make calls; get call records and summaries; get and download recordings; send WhatsApp messages; create and manage sub-accounts, give them numbers, and run their KYC |
| **Vobiz Trigger** | Trigger (checks every minute) | Start a workflow when any call on your account ends, or when a recording is ready |
| **Vobiz Call Answered Trigger** | Trigger (instant) | Tell Vobiz what to say when a call is answered, answer incoming calls on your numbers, and start a workflow the moment a call is answered or ends |
| **Vobiz WhatsApp Trigger** | Trigger (instant) | Start a workflow when a customer messages you on WhatsApp, or when a message you sent is delivered, read or fails |
| **Vobiz KYC Trigger** | Trigger (instant) | Start a workflow when a customer sub-account passes or fails KYC, or its KYC link expires |

The **Vobiz** node can also be used as a tool by n8n's AI Agent.

## Installation

### Self-hosted n8n

1. Go to **Settings → Community Nodes** and select **Install**.
2. Enter `@vobiz-ai/n8n-nodes-vobiz`, agree to the risks of using community nodes, and select **Install**.
3. Search for **Vobiz** in the nodes panel.

### Self-hosted n8n with npm (Docker, queue mode)

```bash
mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes
npm install @vobiz-ai/n8n-nodes-vobiz
```

Restart n8n afterwards.

### n8n Cloud

Once the package is verified by n8n, the Vobiz nodes appear directly in the nodes panel.

See n8n's [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) for more options.

## Credentials

You need a Vobiz account.

1. In the [Vobiz console](https://console.vobiz.ai), open **Settings → API** and copy your **Auth ID** (it starts with `MA_`) and your **Auth Token**.
2. In n8n, create a **Vobiz API** credential and paste both.
3. Leave **API URL** set to `https://api.vobiz.ai`.
4. Select **Save**. n8n checks the credential with Vobiz straight away.

## Nodes

### Vobiz

| Resource | Operation | What it does |
|---|---|---|
| Call | Make | Calls a number from one of your Vobiz numbers. Optionally say a different message on each call, connect the person who answers to another number (**Connect To**, for a call between two people), hang up if voicemail answers, and set the ring timeout, time limit, caller name and keypad digits to send. |
| Call Record | Get | One finished call: numbers, times, duration, cost and how it ended. |
| Call Record | Get Many | Call records, newest first, filtered by date, direction, number, minimum duration, hangup cause or campaign. |
| Call Record | Get Summary | Totals for a period: calls, answered calls, answer rate, minutes and cost. |
| Recording | Get / Get Many | Recording details, for one call or all calls, optionally filtered by recording type. |
| Recording | Download | The audio file as binary data, ready for Google Drive, Slack or email. |
| WhatsApp Message | Send | A text, image, audio, video, document or sticker, or an approved template with its variables. |
| Sub-Account | Create | A sub-account with its own Auth ID and Auth Token, for a customer, a team or a test environment. |
| Sub-Account | Get / Get Many / Update / Delete | Read, rename, change the permissions or rate limit of, switch off, or delete sub-accounts. A switched-off sub-account keeps its numbers. |
| Sub-Account | Assign Number / Unassign Number | Give one of your numbers to a sub-account, or take it back. |
| Sub-Account | Start KYC / Get KYC Status | Send a customer the Vobiz KYC page, by email or as a link, and check whether they have passed and can make calls. |

#### Sub-accounts

A sub-account is a separate account under yours, with its own Auth ID (`SA_…`), Auth Token, numbers and call records. Its usage is billed to your main account. Manage sub-accounts with your **main account's** credential (`MA_…`).

- **KYC:** a *personal use* sub-account shares your KYC and can make calls at once, which suits your own teams and testing. A *customer use* sub-account is for a customer who must be verified in their own name: it needs an email address, and it cannot make calls until their KYC passes. **Start KYC** sends them the Vobiz KYC page; the **Vobiz KYC Trigger** tells you the result.
- **The Auth Token is shown once.** **Create** returns it in its output; Vobiz never shows it again. Save it straight away, for example in a Vobiz credential for the sub-account. n8n also keeps it in that run's execution data.
- **Acting as a sub-account:** to make calls or read call records as the sub-account, add another Vobiz credential with the sub-account's Auth ID and Auth Token, and pick it in the node.
- **Taking a number back** works only if the number has had no calls for 15 days. Vobiz keeps a number that was used recently with the sub-account, so people who still dial it don't reach someone else. Unassign Number says until when.
- **Switching a sub-account to customer use** blocks its calls at once, until its own KYC passes.
- **Delete is permanent:** Vobiz revokes the sub-account's Auth ID and Auth Token at once.

### Vobiz Trigger

Starts a workflow when a **call ends** (incoming or outgoing) or when a **call recording is ready**.

- It checks Vobiz on n8n's schedule (every minute by default), so it needs no setup in Vobiz and never changes where your numbers point.
- It sees every call on your account.
- The first check only notes what already exists, so past calls don't all start the workflow at once.
- **Filters:** answered calls only, direction, a phone number, and a minimum duration.
- For recordings, it can attach the audio file.

### Vobiz Call Answered Trigger

Your n8n phone line. When a call is answered, Vobiz asks this trigger what to do. The trigger replies at once with a spoken message, then runs your workflow. The message can be:

- spoken in any of 16 languages, with a man's or a woman's voice;
- optionally followed by an audio file;
- or replaced entirely by your own Vobiz XML.

After the message, **Then** decides what happens, with no XML to write:

| Then | What the caller gets |
|---|---|
| **Hang Up** | The message, and the call ends. |
| **Forward to a Number** | Connected to a number, such as an agent's phone. Several numbers ring together, and the first to answer gets the call. If nobody answers, the caller hears a message, or can leave a voicemail. |
| **Ask to Press a Key (Menu)** | The message as a menu, such as *"Press 1 for sales, 2 for our hours"*. Each key can forward the call, say a message, or take a voicemail. A wrong key gets the menu once more. |
| **Record a Voicemail** | A beep, then a recording of up to 2 minutes (the caller can press # to finish), then a thank-you. |

Menus, forwarding and voicemail need the workflow to be **published**: Vobiz sends the key, the forwarding result and the recording to the trigger's Production URL.

Settings:

- **Trigger On:** *Call Answered*, *Call Ended*, *Key Pressed*, *Forward Finished* and *Voicemail Recorded*, in any mix. *Call Ended* fires the moment the call finishes, with its duration, whether it was answered and how it ended. *Key Pressed* gives the key. *Forward Finished* says whether the number answered. *Voicemail Recorded* gives the recording's `recording_id` and length; pass the ID to *Vobiz → Recording → Download* to get the audio.
- **Outgoing calls:** paste the trigger's **Production URL** into **Answer URL** on *Vobiz → Call → Make*.
- **Incoming calls:** choose numbers in **Answer Incoming Calls On**. They are connected when you publish the workflow and released when you unpublish it.
- **Require Vobiz Signature** (on by default): Vobiz signs every call event with your Auth Token. The trigger checks that signature, so someone who learns its address cannot start your workflow with made-up calls. A signature that does not match is always refused. Turn this off only if your Vobiz account sends events without a signature.

When the workflow is published, the trigger creates a Vobiz application for its address, named `n8n-call-answered-…`. It removes the application when the workflow is unpublished.

> **Your existing setups are safe.** The trigger only takes numbers that aren't linked to anything else. It refuses a number already used by another application (such as a CRM integration) or routed to a SIP trunk, and changes nothing in your account when it does. The number list labels each number **not linked**, **on a SIP trunk** or **used by …** so you can see which ones are free.

| | Vobiz Trigger | Vobiz Call Answered Trigger |
|---|---|---|
| Which calls | Every call on the account | Calls it answers: on its numbers, or made with it as the Answer URL |
| When it fires | Within about a minute | The moment the call is answered or ends |
| Changes in Vobiz | None | Its own application, and the numbers you choose |

### Vobiz WhatsApp Trigger

Starts a workflow when a customer sends you a WhatsApp message (**Message Received**), or when a message you sent is sent, delivered, read or fails (**Message Status Changed**).

- It registers itself with Vobiz when you publish the workflow, and removes itself when you unpublish it.
- Every event is checked against a signature made with a secret only this trigger knows. Forged events are refused.
- You can limit it to one WhatsApp channel.

### Vobiz KYC Trigger

Starts a workflow when a customer sub-account's KYC moves on: **KYC Started**, **Documents Submitted**, **KYC Completed**, **KYC Failed**, **Link Expired** or **Link Revoked**.

1. Publish the workflow, open the trigger, and copy its **Production URL**.
2. On *Vobiz → Sub-Account → Start KYC*, paste it into **Options → Webhook URL**. Vobiz then reports that customer's KYC to the trigger.

- Use your **main account's** credential: Vobiz signs each KYC event with that account's Auth Token, and the trigger checks the signature. Forged events are refused, and so are unsigned ones while **Require Vobiz Signature** is on.
- You can limit it to one sub-account.
- The output names the sub-account (`sub_account_id`) and the result (`status`), so the next node knows which customer it was. It also passes on any `metadata` Vobiz sends back. To check that the customer can now make calls, add *Vobiz → Sub-Account → Get KYC Status*.

## Quick start: a call that speaks

When a call is answered, Vobiz asks a web address what to say. The Call Answered Trigger is that address.

1. Create a workflow with a **Vobiz Call Answered Trigger**, set its **Message**, and **Publish** the workflow.
2. Open the trigger, select **Webhook URLs → Production URL**, and copy the address. It contains `/webhook/`, not `/webhook-test/`.
3. In another workflow, add **Vobiz → Call → Make**. Pick a **From Number**, enter the number to call in **To**, and paste the address into **Answer URL**.
4. To say something different on each call, fill in **Message** on Make a Call, for example `Hi {{ $json.name }}, your appointment is tomorrow at 10.` It replaces the trigger's message for that call.
5. To act once the call is over, for example to log it or send a WhatsApp follow-up, tick **Call Ended** in the trigger's **Trigger On**.

### A call between two people

n8n cannot talk on a call itself, so Vobiz rings two phones and connects them: first the one in **To**, then the one in **Connect To**.

1. Set up the Call Answered Trigger once, as above, and paste its **Production URL** into **Answer URL** on Make a Call.
2. In Make a Call, put your own phone (or your agent's) in **To**, and the person to talk to in **Connect To**. Both can come from your data, such as `{{ $json.phone }}` from a sheet or CRM row.
3. Leave **Message** empty to connect straight away, or set one, such as *"Connecting you to Asha"*, to hear it first.

When the first phone answers, Vobiz rings the second, showing your Vobiz number, and connects them. If the second phone does not answer, the first hears the trigger's **No Answer Message** (or can leave a voicemail). Each connected phone is billed as its own call.

## Example workflows

- **Appointment reminders:** Google Sheets or a schedule → *Vobiz: Make a Call* with a personalised message.
- **Log every call:** *Vobiz Trigger (Call Ended)* → Google Sheets or your CRM.
- **Missed-call follow-up:** *Vobiz Call Answered Trigger (Call Ended)* → If not answered → *Vobiz: Send* a WhatsApp template.
- **Phone menu with voicemail to email:** *Vobiz Call Answered Trigger* (Then: Menu; 1 forwards to sales, 2 takes a voicemail; Trigger On: Voicemail Recorded) → *Vobiz: Recording → Download* → Gmail.
- **Agent missed the call:** *Vobiz Call Answered Trigger* (Then: Forward; Trigger On: Forward Finished) → If not answered → Slack.
- **Recordings to cloud storage:** *Vobiz Trigger (Recording Ready, Download Recording on)* → Google Drive.
- **WhatsApp auto-reply:** *Vobiz WhatsApp Trigger (Message Received)* → *Vobiz: Send* a WhatsApp text.
- **Daily call report:** Schedule → *Vobiz: Call Record → Get Summary* → Slack.
- **Customer onboarding:** a sign-up form → *Vobiz: Sub-Account → Create* (customer use) → *Start KYC* by email. Then *Vobiz KYC Trigger (KYC Completed)* → *Assign Number* → a WhatsApp welcome.

## Good to know

- **Instant triggers need a public address.** Vobiz sends events over the internet, so the Call Answered, WhatsApp and KYC triggers need n8n to be reachable over HTTPS. This works automatically on n8n Cloud. On self-hosted n8n, set `WEBHOOK_URL` to your public address.
- **If your public address changes**, for example with a tunnel that gets a new address on every restart, unpublish and publish your trigger workflows again so Vobiz uses the new address.
- **WhatsApp's 24-hour rule.** Free-form messages can only be sent within 24 hours of the customer's last message. For a first message, or outside that window, send an approved template. A free-form message sent outside the window is reported as `failed` in a *Message Status Changed* event.
- **Recordings are private.** Their links need your Vobiz credential, so use **Recording → Download**, or **Download Recording** on the trigger, to get the file.
- **Call records** appear a few seconds after a call ends.
- **Phone numbers** use international format with the country code, for example `+919876543210`. Spaces and dashes are removed for you.
- **Hang Up on Voicemail** is off by default. Voicemail detection listens for up to 5 seconds and can mistake a person who stays silent for a machine.
- **Avoid Retry On Fail on Make a Call.** If a request is retried, the same call can be placed twice.

## Security

- Your Auth ID and Auth Token are kept in n8n's encrypted credential store and are sent only to Vobiz.
- Recording downloads send your credential only to Vobiz hosts, never to any other domain.
- Call events to the Call Answered Trigger are verified against Vobiz's `X-Vobiz-Signature-V3` (or V2) header, an HMAC-SHA256 of the trigger's address and a nonce, keyed with your Auth Token. Forged events are rejected with 403, and so are unsigned ones while **Require Vobiz Signature** is on.
- WhatsApp events are verified with HMAC-SHA256, using a secret created for each subscription. Unsigned or forged events are rejected.
- KYC events to the KYC Trigger are verified against Vobiz's `X-Vobiz-Signature` header, an HMAC-SHA256 of the raw body keyed with your main account's Auth Token. Forged events are rejected with 401, and so are unsigned ones while **Require Vobiz Signature** is on.
- A new sub-account's Auth Token is passed on only by **Create**, the one time Vobiz shows it. Every other sub-account operation leaves the token out of its output.
- The package has no runtime dependencies beyond n8n itself.

## Troubleshooting

| You see | Why | Fix |
|---|---|---|
| `Vobiz did not accept the Auth ID or Auth Token` | The credential is wrong | Copy both again from **Settings → API** in the Vobiz console |
| `Vobiz cannot reach an Answer URL on localhost` or `Vobiz cannot reach n8n on localhost` | n8n has no public address | Set `WEBHOOK_URL` to a public HTTPS address, then use the trigger's **Production URL** |
| The phone rings, then there is silence | The Answer URL is the trigger's Test URL, or the trigger workflow isn't published | Publish the trigger workflow and use its **Production URL** |
| `… already answers calls for the Vobiz application …` | That number is used by another setup | Choose a number marked **not linked** |
| `Your Vobiz balance is too low for this` | Your account balance | Top up in the Vobiz console |
| `The template "…" is PENDING_REVIEW, not approved` | Meta hasn't approved the template yet | Wait for approval, or choose another template |
| `No recent call matches these filters` | No matching call yet | Make and answer a call, wait a minute, and fetch again |
| The phone rings, then silence, and n8n's log says `a request was refused: it had no Vobiz signature` | Your Vobiz account sends call events without a signature | Turn off **Require Vobiz Signature** on the Call Answered Trigger |
| n8n's log says `a request was refused: its Vobiz signature did not match` | The trigger's credential is for a different Vobiz account than the call, or `WEBHOOK_URL` is not the address Vobiz calls | Use the credential of the account that owns the number, and set `WEBHOOK_URL` to n8n's public address |
| Triggers stop receiving events after n8n restarts | n8n's public address changed | Unpublish and publish the workflow again |
| Publishing fails with `"…" in Forward To is not a phone number with its country code` | A number in **Forward To** is written without its country code, or is not a number | Write it like `+919876543210` |
| A menu or voicemail call goes silent after the message | The workflow is not published, so Vobiz's follow-up gets no answer | Publish the workflow, and use its **Production URL** |
| `Sub-accounts are managed with the main account's credential` | The node uses a sub-account's credential (`SA_…`) | Pick the main account's credential (`MA_…`) |
| `This sub-account does not belong to the account in this credential` | The sub-account was made by another main account | Use the credential of the main account that created it |
| `Vobiz keeps +91… with the sub-account until …` | The number had a call in the last 15 days | Try again after that date |
| n8n's log says `Vobiz KYC Trigger: an event was refused: its Vobiz signature did not match` | The trigger's credential is not the main account that owns the sub-account | Pick that main account's credential in the trigger |

## Compatibility

Built with [`@n8n/node-cli`](https://www.npmjs.com/package/@n8n/node-cli) and tested with n8n 2.37. You need a Vobiz account; the WhatsApp features also need a WhatsApp channel on that account.

## Development

Use a current Node.js 24 (see `.nvmrc`; 24.21 or newer). The npm bundled with older 24.x releases (11.9 and earlier) rejects the lockfile in `npm ci`.

```bash
git clone https://github.com/vobiz-ai/Vobiz-n8n-nodes.git
cd Vobiz-n8n-nodes
npm install
npm run build   # compile to dist/
npm run lint    # n8n's lint rules
npm test        # unit tests against a mock Vobiz API
```

`npm run test:e2e` runs the built nodes inside a real n8n against the mock API, so nothing is called, texted or billed. To run a local n8n with the nodes loaded and test against a real Vobiz account, run `npm run n8n` (Windows, macOS or Linux) and see [TESTING.md](TESTING.md).

Issues and pull requests are welcome.

## Support

- **Vobiz API documentation:** [vobiz.ai/docs](https://www.vobiz.ai/docs)
- **Bugs and feature requests:** [GitHub Issues](https://github.com/vobiz-ai/Vobiz-n8n-nodes/issues)
- **Vobiz account and billing:** [support@vobiz.ai](mailto:support@vobiz.ai)

## Version history

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE.md) © Vobiz AI
