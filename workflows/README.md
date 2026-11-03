# Vobiz workflow templates for n8n

Ready-made n8n workflows for Vobiz voice and WhatsApp. Each one is a JSON file you can import into n8n.

## Before you start

1. [Install the Vobiz node](https://www.vobiz.ai/docs/integrations/n8n) and add your Vobiz credential.
2. Connect the credentials each workflow needs, and replace placeholder values such as `you@example.com`.
3. Workflows that make calls place real calls, billed to your Vobiz account. Test with your own number first.

## Import a workflow

In n8n, create a workflow, click the **⋯** menu at the top right, then **Import** → **From URL**, and paste the raw link from the table. To use a downloaded file, choose **From File**.

## Workflows

| Workflow | What it does | Also needs | File |
|---|---|---|---|
| **Answer calls with a greeting** | Answers calls to your number with a message, then hangs up. | - | [view](01-answer-calls-with-a-greeting.json) · [raw](https://raw.githubusercontent.com/vobiz-ai/Vobiz-n8n-nodes/main/workflows/01-answer-calls-with-a-greeting.json) |
| **Forward calls to your team** | Greets the caller and rings your team together; the caller can leave a voicemail if nobody answers. | - | [view](02-forward-calls-to-your-team.json) · [raw](https://raw.githubusercontent.com/vobiz-ai/Vobiz-n8n-nodes/main/workflows/02-forward-calls-to-your-team.json) |
| **Phone menu (IVR)** | Press 1 for sales, 2 for support, 3 for opening hours, 4 to leave a message. | - | [view](03-phone-menu.json) · [raw](https://raw.githubusercontent.com/vobiz-ai/Vobiz-n8n-nodes/main/workflows/03-phone-menu.json) |
| **Make a call that speaks a message** | Calls a number and reads out your message when they answer. | - | [view](04-make-a-call-that-speaks-a-message.json) · [raw](https://raw.githubusercontent.com/vobiz-ai/Vobiz-n8n-nodes/main/workflows/04-make-a-call-that-speaks-a-message.json) |
| **Voice OTP call** | Your app sends a phone number and a code; Vobiz calls and reads the code out twice. | - | [view](05-voice-otp-call.json) · [raw](https://raw.githubusercontent.com/vobiz-ai/Vobiz-n8n-nodes/main/workflows/05-voice-otp-call.json) |
| **Appointment reminder calls** | Every morning, calls everyone in a Google Sheet whose appointment is tomorrow. | Google Sheets | [view](06-appointment-reminder-calls.json) · [raw](https://raw.githubusercontent.com/vobiz-ai/Vobiz-n8n-nodes/main/workflows/06-appointment-reminder-calls.json) |
| **Call back website leads** | A lead fills in a form; Vobiz calls your agent, then connects them to the lead. | - | [view](07-call-back-website-leads.json) · [raw](https://raw.githubusercontent.com/vobiz-ai/Vobiz-n8n-nodes/main/workflows/07-call-back-website-leads.json) |
| **WhatsApp when a call is not answered** | When someone doesn't pick up your call, sends them a WhatsApp template. | A WhatsApp channel | [view](08-whatsapp-when-a-call-is-not-answered.json) · [raw](https://raw.githubusercontent.com/vobiz-ai/Vobiz-n8n-nodes/main/workflows/08-whatsapp-when-a-call-is-not-answered.json) |
| **Voicemail to email** | Callers leave a voicemail; you get it by email with the recording attached. | Gmail | [view](09-voicemail-to-email.json) · [raw](https://raw.githubusercontent.com/vobiz-ai/Vobiz-n8n-nodes/main/workflows/09-voicemail-to-email.json) |
| **Slack alert for missed forwarded calls** | Forwards calls to an agent and posts in Slack when nobody answers. | Slack | [view](10-slack-alert-for-missed-forwarded-calls.json) · [raw](https://raw.githubusercontent.com/vobiz-ai/Vobiz-n8n-nodes/main/workflows/10-slack-alert-for-missed-forwarded-calls.json) |
| **Log every call to Google Sheets** | Every 15 minutes, adds new calls on your account to a Google Sheet. | Google Sheets | [view](11-log-every-call-to-google-sheets.json) · [raw](https://raw.githubusercontent.com/vobiz-ai/Vobiz-n8n-nodes/main/workflows/11-log-every-call-to-google-sheets.json) |
| **Daily call report to Slack** | Every evening, posts the day's calls, answer rate, talk time and cost in Slack. | Slack | [view](12-daily-call-report-to-slack.json) · [raw](https://raw.githubusercontent.com/vobiz-ai/Vobiz-n8n-nodes/main/workflows/12-daily-call-report-to-slack.json) |
| **Back up call recordings to Google Drive** | Every hour, saves new call recordings to Google Drive. | Google Drive | [view](13-back-up-call-recordings-to-google-drive.json) · [raw](https://raw.githubusercontent.com/vobiz-ai/Vobiz-n8n-nodes/main/workflows/13-back-up-call-recordings-to-google-drive.json) |
| **WhatsApp auto-reply** | Replies to every WhatsApp message you receive. | A WhatsApp channel | [view](14-whatsapp-auto-reply.json) · [raw](https://raw.githubusercontent.com/vobiz-ai/Vobiz-n8n-nodes/main/workflows/14-whatsapp-auto-reply.json) |
| **Order confirmation call (press 1 or 2)** | Calls each new order's customer: press 1 to confirm, 2 to cancel; your store gets the answer. | Your store's API | [view](15-order-confirmation-call.json) · [raw](https://raw.githubusercontent.com/vobiz-ai/Vobiz-n8n-nodes/main/workflows/15-order-confirmation-call.json) |
| **Calling campaign with results in Google Sheets** | Calls a list from Google Sheets one by one, then logs each call's result to another sheet. | Google Sheets | [view](16-calling-campaign-with-results-in-google-sheets.json) · [raw](https://raw.githubusercontent.com/vobiz-ai/Vobiz-n8n-nodes/main/workflows/16-calling-campaign-with-results-in-google-sheets.json) |
| **Alert escalation calls** | Calls your on-call engineer when an alert fires, and calls a backup if they don't answer. | A monitoring tool that can send webhooks | [view](17-alert-escalation-calls.json) · [raw](https://raw.githubusercontent.com/vobiz-ai/Vobiz-n8n-nodes/main/workflows/17-alert-escalation-calls.json) |
| **AI voicemail summary in Slack** | Transcribes each voicemail with OpenAI and posts a short summary in Slack. | OpenAI, Slack | [view](18-ai-voicemail-summary.json) · [raw](https://raw.githubusercontent.com/vobiz-ai/Vobiz-n8n-nodes/main/workflows/18-ai-voicemail-summary.json) |
| **AI chat with your call data** | Ask questions like "how many calls did we miss yesterday?"; an AI agent answers using Vobiz as a tool. | OpenAI | [view](19-ai-chat-with-your-call-data.json) · [raw](https://raw.githubusercontent.com/vobiz-ai/Vobiz-n8n-nodes/main/workflows/19-ai-chat-with-your-call-data.json) |
| **Customer onboarding with sub-account and KYC** | A sign-up form creates a customer sub-account and emails the KYC link; when KYC passes, it gives them a number. | Gmail | [view](20-customer-onboarding-with-kyc.json) · [raw](https://raw.githubusercontent.com/vobiz-ai/Vobiz-n8n-nodes/main/workflows/20-customer-onboarding-with-kyc.json) |

See the [Vobiz n8n guide](https://www.vobiz.ai/docs/integrations/n8n) for setup details.
