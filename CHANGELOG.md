# Changelog

## Unreleased

- **Vobiz Call Answered Trigger** now checks Vobiz's signature on every call event (`X-Vobiz-Signature-V3`, or V2), so nobody who learns the trigger's address can start the workflow with made-up calls. A new **Require Vobiz Signature** setting, on by default, also refuses unsigned events; turn it off only if your Vobiz account does not sign them.

## 0.1.0

First version.

- **Vobiz** node: make a call; get one, many or a summary of call records; get, list and download recordings; send WhatsApp text, media and template messages.
- **Vobiz Trigger**: starts a workflow when a call ends or a recording is ready, for every call on the account.
- **Vobiz Call Answered Trigger**: tells Vobiz what to say when a call is answered; answers incoming calls on the numbers you choose (never one used by another setup); starts the workflow the moment a call is answered or ends.
- **Vobiz WhatsApp Trigger**: starts a workflow on incoming WhatsApp messages and delivery updates, with signature checks.
