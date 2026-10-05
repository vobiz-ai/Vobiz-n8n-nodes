# Changelog

## 0.2.0 - 2026-10-05

- **Vobiz** node: a new **Sub-Account** resource. **Create**, **Get**, **Get Many**, **Update** and **Delete** sub-accounts (personal use, sharing your KYC, or customer use, with their own KYC). **Assign Number** and **Unassign Number** move a number between your main account and a sub-account; Unassign says until when when Vobiz's 15-day cool-off applies. **Start KYC** sends a customer the Vobiz KYC page by email or as a link, and **Get KYC Status** says whether they can make calls yet. Only **Create** passes on the new sub-account's Auth Token, the one time Vobiz shows it.
- **Vobiz → Call → Make:** a new **Connect To** field for a call between two people. Once the person in To answers, the Call Answered Trigger connects them to this number; each call can name a different one. The trigger then says only Make a Call's own Message, or nothing.
- **Vobiz Call Answered Trigger:** **Message** can be left empty, so calls can be forwarded without a greeting.
- **Vobiz Call Answered Trigger:** a new **Then** setting for what happens after the message, with no XML to write. **Forward to a Number** connects the caller to one or more numbers (the first to answer gets the call), with a message or a voicemail when nobody answers. **Ask to Press a Key (Menu)** plays the message as a menu where each key forwards, says a message or takes a voicemail. **Record a Voicemail** records the caller after a beep. Three new **Trigger On** events: *Key Pressed*, *Forward Finished* and *Voicemail Recorded*. Forward numbers and menus are checked when the workflow is published.
- New **Vobiz KYC Trigger**: starts a workflow when a customer sub-account's KYC is started, submitted, completed, failed, expired or revoked. It checks Vobiz's `X-Vobiz-Signature` on every event and can be limited to one sub-account.
- **Vobiz Call Answered Trigger** now checks Vobiz's signature on every call event (`X-Vobiz-Signature-V3`, or V2), so nobody who learns the trigger's address can start the workflow with made-up calls. A new **Require Vobiz Signature** setting, on by default, also refuses unsigned events; turn it off only if your Vobiz account does not sign them.

## 0.1.1 - 2026-10-02

- The official Vobiz symbol as the node icon, in light and dark.
- A leaner package (52 kB instead of 112 kB): only the built files are published.
- Published from GitHub Actions with npm provenance.

## 0.1.0

First version.

- **Vobiz** node: make a call; get one, many or a summary of call records; get, list and download recordings; send WhatsApp text, media and template messages.
- **Vobiz Trigger**: starts a workflow when a call ends or a recording is ready, for every call on the account.
- **Vobiz Call Answered Trigger**: tells Vobiz what to say when a call is answered; answers incoming calls on the numbers you choose (never one used by another setup); starts the workflow the moment a call is answered or ends.
- **Vobiz WhatsApp Trigger**: starts a workflow on incoming WhatsApp messages and delivery updates, with signature checks.
