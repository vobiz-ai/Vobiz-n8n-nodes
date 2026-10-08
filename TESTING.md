# Testing the Vobiz nodes on your computer

This runs a private n8n on your computer with the Vobiz nodes loaded. It uses its own
folder, `.n8n-vobiz` in your home folder, so your usual n8n and its workflows are not
touched. Only test 1 changes where a number points, and only for numbers you
choose that aren't linked to anything else.

Real calls and WhatsApp messages cost what they normally cost on Vobiz. Each test
call below lasts under a minute.

**You need:** Windows, macOS or Linux, a current [Node.js](https://nodejs.org) 24 (see
`.nvmrc`; n8n needs 24 or newer), and
[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
(Windows: `winget install --id Cloudflare.cloudflared`; macOS: `brew install cloudflared`).

## 1. Start it

1. Open a terminal (PowerShell on Windows) in the project folder.
2. Run:
   ```
   npm run n8n
   ```
   Add `-- --no-tunnel` to start without a public address, or `-- --port 5700` for another port.
3. Wait for `Editor is now accessible`. The first start takes a few minutes while n8n sets up its database.
4. The window shows two addresses. Keep the window open; closing it stops n8n.
   - **Open n8n here:** `http://localhost:5688`
   - **Public address:** `https://….trycloudflare.com` (new every time you start)
5. Open `http://localhost:5688` in your browser. The first time, n8n shows **Set up owner account**. **Fill it in straight away, with a strong password** (8+ characters, with a number and a capital letter), then click **Next**. The public address leads to the same n8n, and whoever creates the owner account first controls it.
6. n8n then shows an **AI Assistant** page. Click **Set up later in Settings**.

To stop: click the terminal window and press **Ctrl+C**.

## 2. Add your Vobiz login once

1. Click the **+** at the very top left of n8n → **New credential**.
2. In **Add new credential**, type `Vobiz`, click **Vobiz API**, then **Continue**.
3. **Auth ID** and **Auth Token**: copy them from the Vobiz console, **Settings → API**.
4. Leave **API URL** (`https://api.vobiz.ai`) and **Allowed HTTP Request Domains** (**All**) as they are.
5. Click **Save** (top right of the box). It shows **Connection tested successfully**. Close the box with the **✕**.

## 3. Import the test workflows

The folder `test-workflows` holds ten ready-made workflows with the phone numbers left blank. To get copies with your own details filled in, run this from the project folder. The variables are:
- the Vobiz numbers you'll test with, separated by commas;
- your own mobile;
- your own email, for the KYC test;
- a second phone of yours to act as the agent, for the forwarding test.

```powershell
# Windows (PowerShell)
$env:VOBIZ_TEST_NUMBERS = '+91XXXXXXXXXX'
$env:VOBIZ_TEST_MY_MOBILE = '+91XXXXXXXXXX'
$env:VOBIZ_TEST_MY_EMAIL = 'you@example.com'
$env:VOBIZ_TEST_AGENT = '+91XXXXXXXXXX'
node scripts/make-test-workflows.js
```

```bash
# macOS / Linux
VOBIZ_TEST_NUMBERS='+91XXXXXXXXXX' VOBIZ_TEST_MY_MOBILE='+91XXXXXXXXXX' VOBIZ_TEST_MY_EMAIL='you@example.com' VOBIZ_TEST_AGENT='+91XXXXXXXXXX' node scripts/make-test-workflows.js
```

That writes the same ten into `test-workflows/local`. Use those instead. The folder is ignored by git, so your numbers stay on your computer.

For each one:

1. Click **+** (top left) → **New workflow**.
2. Click the **⋯** next to the name **My workflow** (top left) → **Import** → **From file**, and choose the file.
3. n8n fills in your Vobiz credential by itself and says **Credentials auto-added**. If a node still has none, double-click it and pick **Vobiz account** under **Credential**.

Each workflow has a yellow note with its steps. The **Editor** / **Executions** tabs are at the top middle, **Publish** is at the top right, and **Execute workflow** is at the bottom middle.

## 4. The tests

### Test 1: the n8n phone line (Vobiz Trigger, Source: Calls)
File: `1 - Phone line (answers calls).json`

This gives n8n its own phone numbers: use numbers that show **not linked** in the Vobiz console. Numbers used by another setup, such as a CRM integration, are never touched. The trigger refuses any number that's already linked to something.

1. Pick your credential in the trigger. **Source** is **Calls**.
2. **Answer Incoming Calls On**: your n8n numbers (already set in the `local` copy). The list says which numbers are **not linked** and which are used by something else.
3. **Trigger On**: **Call Answered** and **Call Ended** are both ticked.
4. Close the panel (**✕**, top right), click **Publish** (top right), then **Publish** again in the **Publish workflow** box.
5. From your mobile, call one of those numbers.

**Expected:**
- You hear: *"Hello! You have reached the n8n test line on Vobiz…"*, then the call ends.
- **Executions** (top of the workflow) shows two runs, straight away: one for *call answered*, one for *call ended*, with the duration and how the call ended.
- In the Vobiz console, under **Voice → Applications**, there's a new application named `n8n-call-answered-…`, and your n8n numbers show it as their voice app.

Then go back to **Editor**, double-click the trigger, click **Webhook URLs**, click the **Production URL** tab, and copy the address under it (it contains `/webhook/`, not `/webhook-test/`). Test 2 needs it.

### Test 2: make a call (Vobiz → Call → Make)
File: `2 - Make a call.json`

1. **From Number**: one of your n8n numbers (already set in the `local` copy). Use an n8n number, so that if someone calls back, they reach the n8n line.
2. **To**: your own mobile, with the country code, e.g. `+9198XXXXXXXX`.
3. **Answer URL**: paste the Production URL from test 1.
4. Click **Execute workflow**.

**Expected:**
- Your phone rings.
- When you answer, after a one-second pause, you hear: *"Hi! This message came from the Make a Call node. Goodbye."* Then the call ends.
- The node's output shows Vobiz's `message` (for example `call queued`) and a `call_uuid`.
- Workflow 1's **Executions** shows *call answered*, then *call ended*, as they happen.

To hear test 1's own message instead, empty the **Message** field in Make a Call.

### Test 2b: a call between two people (Make a Call → Connect To)
File: `2 - Make a call.json` again

1. In test 1's trigger, set **Then** back to **Hang Up**. Connect To does not need the trigger's own forwarding.
2. In **Make a Call**: **To** is your own mobile. **Connect To** is a second phone you own. Empty **Message** to connect without a greeting.
3. Click **Execute workflow**.

**Expected:** your mobile rings. When you answer, the second phone rings, showing your n8n number. Answer it: the two phones are connected. Hang up either phone and the call ends.

Then try once without answering the second phone: after about 30 seconds your mobile hears *"Sorry, nobody is available to take your call right now. Goodbye."*

### Test 3: every call on the account (Schedule → Vobiz Get Many → Remove Duplicates)
File: `3 - Every call on the account.json`

This one watches every number, CRM numbers included, without changing anything about them. n8n's **Schedule Trigger** checks once a minute, so a call shows up within about a minute.

1. Pick your credential in **Recent Calls**.
2. Click **Execute workflow**. **Recent Calls** and **Only New Calls** show your latest calls: numbers, duration, cost. The first run passes them all on.
3. Click **Publish**, then make any call, answer it, and hang up.
4. Within about a minute, open **Executions**. A new run holds just that call; runs with no new call pass nothing on.

### Test 4: call records (Vobiz → Call Record)
File: `4 - Call records report.json`

Click **Execute workflow**.

**Expected:**
- **Last 7 Days Summary** shows totals: calls, answered calls, answer rate, minutes and cost.
- **Latest 10 Calls** shows your last 10 calls.

### Test 5: recordings (Vobiz → Recording)
File: `5 - Download latest recording.json`

This needs at least one recorded call on your account.

1. Click **Execute workflow**.
2. Open **Download It** and click the **Binary** tab. The recording is there, and it plays in the browser.

### Test 6: send WhatsApp (Vobiz → WhatsApp Message → Send)
File: `6 - Send a WhatsApp message.json`

This needs a WhatsApp channel on your Vobiz account.

1. **Channel**: pick yours.
2. **To**: your own WhatsApp number.
3. **Template**: pick an approved one. A first message has to be a template.
4. Click **Execute workflow**.

**Expected:** the message arrives on your phone. The node's output shows `status: pending`.

### Test 7: WhatsApp auto-reply (Vobiz Trigger, Source: WhatsApp)
File: `7 - WhatsApp auto-reply.json`

1. Pick the same **Channel** in **Reply**.
2. Click **Publish**.
3. From your phone, send a WhatsApp message to your business number.

**Expected:** you get back *"Thanks <your name>! We got your message: …"*.

### Test 8: sub-accounts (Vobiz → Sub-Account)
File: `8 - Sub-accounts.json`

Sub-accounts are made with the **main account's** credential (its Auth ID starts with `MA_`). If you share that account with other people, tell them first: this test adds a sub-account named *n8n test sub-account* for a few seconds.

1. Pick the main account's credential in every Vobiz node.
2. Click **Execute workflow**.

**Expected:**
- **Create Test Sub-Account** shows an `auth_id` starting with `SA_` and an `auth_token`.
- **Get It** shows the same sub-account, without the `auth_token`.
- **Change It** shows the new description, and `cdr: false` under permissions.
- **Delete It** shows `deleted: true`.
- **List Sub-Accounts** no longer lists *n8n test sub-account*.

Optional, by hand: **Assign Number** and **Unassign Number**. Use only a number that has had **no calls in the last 15 days**. Vobiz keeps a recently used number with the sub-account for 15 days after its last call, and Unassign Number then says until when.

### Test 9: sub-account KYC (Vobiz → Sub-Account → Start KYC, and the Vobiz Trigger with Source: Sub-Account KYC)
File: `9 - Sub-account KYC.json`

1. Pick the main account's credential in every Vobiz node and in **Vobiz Trigger (KYC)**.
2. Click **Publish**. Open **Vobiz Trigger (KYC)**, copy its **Production URL**, and paste it into **Start KYC → Options → Webhook URL**.
3. Check **Customer Email** on **Create Customer Sub-Account** (your own email).
4. Click **Execute workflow**.

**Expected:**
- **Create Customer Sub-Account** shows `kyc_calls_blocked: true`.
- **Start KYC** shows a `widget_url` link to the Vobiz KYC page. Don't submit documents: this test only checks the link and the events.
- **KYC Status** shows the KYC as not done yet, and `kyc_calls_blocked: true`.
- In **Executions**, the trigger has run for *KYC Started* (`kyc.initiated`).

Then clean up: open **Delete Test Sub-Account (run last)**, pick *n8n KYC test* from the list, and click **Execute step**.

### Test 10: call menu, forwarding and voicemail (Vobiz Trigger, Source: Calls, Then)
File: `10 - Call menu (forward, voicemail).json`

1. **Unpublish test 1 first.** Both answer calls on the same numbers, and a number can only belong to one trigger.
2. In the trigger, **Menu Choices**, key 1: **Forward To** is your agent phone (already set in the `local` copy).
3. Pick your credential in the trigger and in **Download Voicemail**. Click **Publish**.
4. From your mobile, call your n8n number three times:
   - **Press 2.** You hear the opening hours, then the call ends.
   - **Press 3.** You hear the prompt, then a beep. Say something, then press **#**. You hear "Thank you. Your message has been recorded."
   - **Press 1.** You hear "Connecting you to an agent", and the agent phone rings, showing your n8n number. Let it ring out (20 seconds): you hear the voicemail prompt. Hang up.
5. Call once more and press **7**. You hear "Sorry, that is not one of the choices", and the menu again.

**Expected in Executions:**
- one run per key pressed (`call.key_pressed`, with the key);
- one for the forward that nobody answered (`call.forward_finished`, `answered: false`);
- one per voicemail (`call.voicemail_recorded`), whose **Download Voicemail** has the audio under **Binary**;
- one for each call's end.

Then answer the agent phone on another call with key 1: the two phones are connected, and `call.forward_finished` says `answered: true` when the call ends.

## When you're done

1. Switch off workflows 1, 7, 9 and 10: click **Published**, then **Unpublish**. That gives your n8n numbers back (they show **not linked** again), and removes the Vobiz application and the WhatsApp subscription they created.
2. Then press **Ctrl+C** in the terminal window.

If you stop n8n while they're still on, unpublish and publish them again after the next start: the public address has changed, and n8n doesn't tell Vobiz about the new one by itself.

## If something goes wrong

| You see | Why | Fix |
|---|---|---|
| `Vobiz did not accept the Auth ID or Auth Token` | The credential is wrong | Copy both again from **Settings → API** |
| `Vobiz cannot reach an Answer URL on localhost` | You copied the Test URL, or started with `--no-tunnel` | Copy the **Production URL** after publishing workflow 1 |
| The phone rings, but there is silence and then it hangs up | Workflow 1 is not published, or n8n was restarted and the address changed | Publish workflow 1, copy its Production URL again, and paste it into Make a Call |
| Publishing test 1 fails with `… already answers calls for the Vobiz application …` | That number is used by another setup, such as a CRM integration | Choose a number marked **not linked**. The trigger won't take a number from anything else |
| After restarting n8n, the phone line or the WhatsApp trigger gets nothing | The tunnel address is new every start, and n8n doesn't re-register published triggers when it restarts, so Vobiz still sends to the old address | In each published trigger workflow: arrow next to **Published** → **Unpublish**, then **Publish** again. That registers it at the new address |
| `Your Vobiz balance is too low for this` | The account balance | Top up in the Vobiz console |
| `No recent call matches these filters` | No answered call yet | Make and answer a call, wait a minute, fetch again |
| `The template "…" is PENDING_REVIEW` | Meta has not approved it yet | Wait for approval, or pick another template |
