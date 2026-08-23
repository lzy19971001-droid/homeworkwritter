# Homework Writer

A single-page web tool that signs you in with Google, takes some text (pasted or from a
file), creates a **new Google Doc in your own Drive**, and then types the text into it the
way a person would — in bursts, with pauses at sentence and paragraph breaks, and with the
occasional typo that gets noticed and backspaced away.

There is no server and no database. Everything runs in your browser and talks straight to
Google's APIs with a token you grant. There is no client secret anywhere in this repo,
because the browser token flow does not use one.

```
you → browser → Google OAuth → Google Docs API → your Doc
```

## What it does

- **Sign in with Google** (OAuth 2.0 token flow, via Google Identity Services).
- **Paste text** or **upload a file**:
  - `.txt`, `.md`, `.csv`, and other text formats are read locally.
  - `.docx` is unzipped and parsed *in the browser* — no upload, no library.
  - `.pdf`, `.doc`, `.odt`, `.rtf` are converted by Google Drive: the file is uploaded,
    converted, exported as text, and the temporary copy is moved to your Drive trash.
- **Creates a new Doc** (optionally inside a Drive folder it creates for you).
- **Types it in like a human**: adjustable speed (15–140 wpm), typo rate, and how long it
  stops to "think" between sentences and paragraphs.
- **Pause / resume / stop** at any point; if a run fails or is stopped, pressing start again
  continues in the same document from where it left off.

Because every burst is a separate Docs API edit, the document's **version history in Google
Docs shows it being written over time** rather than appearing in one paste.

## Setup

The app needs one thing from you: a Google OAuth **client ID**. It is public information —
safe to commit and safe to paste into the page.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create a project
   (or pick an existing one).
2. **APIs & Services → Library**: enable **Google Docs API** and **Google Drive API**.
3. **APIs & Services → OAuth consent screen**:
   - User type **External** is fine.
   - Fill in app name and support email.
   - Add the scopes `.../auth/documents` and `.../auth/drive.file` (plus `openid`, `email`,
     `profile`, which are non-sensitive).
   - While the app is in **Testing**, add your own Google account under **Test users**.
     Only listed test users can sign in until you publish.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorised JavaScript origins** — add every origin you will open the page from:
     - `http://localhost:8000` for local use
     - `https://<your-github-username>.github.io` for GitHub Pages
   - No redirect URI is needed for this flow.
5. Copy the client ID (it ends in `.apps.googleusercontent.com`) and either:
   - paste it into the yellow box the app shows on first load (stored in `localStorage`), or
   - set `DEFAULT_CLIENT_ID` in [`src/config.js`](src/config.js) and commit it.

### Scopes, and why they are narrow

| Scope | What it allows |
| --- | --- |
| `auth/documents` | Create and edit Google Docs |
| `auth/drive.file` | See and manage **only the files this app creates** — not your existing Drive |
| `openid`, `email`, `profile` | Show which account is signed in |

`drive.file` is deliberate: the app can never read the rest of your Drive.

## Running it

It is static files, but it must be served over HTTP — ES modules and Google sign-in do not
work from `file://`.

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>.

### Deploying to GitHub Pages

Push to `main`, then in the repository: **Settings → Pages → Source: Deploy from a branch →
`main` / root**. Add the resulting `https://<user>.github.io` origin to your OAuth client's
authorised JavaScript origins.

## How the typing works

[`src/typist.js`](src/typist.js) holds the model.

- Text is split into words with their whitespace attached, then accumulated into a buffer.
- Roughly every 1.6 seconds of "typing time" the buffer is flushed as one
  `documents.batchUpdate` → `insertText` call appended at the end of the body. Sending one
  request per character would be far slower and would blow through the API quota; bursts of
  a second or two are also how Google Docs itself groups keystrokes into revisions.
- After each flush the code sleeps for however long those characters *should* have taken at
  the target wpm, minus the time the request itself took, with ±20% jitter.
- A typo fires on some fraction of words of 4+ letters. The misspelling is typed
  (adjacent-key slip, transposition, doubled letter, or dropped letter), there is a pause of
  0.2–0.9 s while it is "noticed", then a `deleteContentRange` removes it and the correct
  spelling follows.
- Pauses land at sentence ends, at paragraph breaks (where the speed also drifts up or down
  a little for the next paragraph), and at random intervals mid-flow.
- A sliding-window rate limiter keeps requests under `MAX_REQUESTS_PER_MINUTE`, and every
  call retries 429/5xx with exponential backoff and refreshes the token on 401.

The cursor position is tracked locally: a Doc body always ends with a newline that cannot be
deleted, so with *n* characters typed the body's end index is *n + 2*. If a delete ever
fails, the code re-reads the real length from the API and retries.

## Testing without a Google account

Open <http://localhost:8000/tests/simulate.html>. It swaps the Docs API for an in-page mock
document and runs the real `typist.js` against it:

- **Run simulation** types the sample text at 70 wpm so you can watch the pacing, the
  hesitations and the typo corrections happen live.
- **Run 200x speed self-test** replays four configurations (including one where *every*
  eligible word is mistyped first) and asserts the finished document matches the source
  character for character — this is what proves the `deleteContentRange` index maths.
- **Test the .docx reader** parses `tests/fixture.docx` and checks the extracted text.

## Things worth knowing

- **Keep the tab in the foreground.** Browsers throttle timers in background tabs, which
  makes a run take much longer than the estimate.
- **Long documents take real time.** 5,000 characters at 55 wpm is about 20 minutes. That is
  the point of the tool, but the estimate is shown before you start.
- **The token lasts an hour** and is renewed silently. If the browser blocks the silent
  renewal, the run stops with an error — press start again to continue in the same document.
- **The Drive folder field** only matches folders this app created — under `drive.file` it
  cannot see the rest of your Drive, so a folder you made by hand in Drive will not be found
  and a new one of the same name is created instead.
- Text is normalised before typing: CRLF → LF, non-breaking spaces → spaces, runs of blank
  lines collapsed. Formatting (bold, headings, tables) is not carried over; this types plain
  text.

## Layout

```
index.html          UI
assets/styles.css   styling
src/config.js       client ID, scopes, rate cap
src/auth.js         Google Identity Services token flow
src/gdocs.js        Docs + Drive REST calls, retries, quota pacing
src/extract.js      file → text (incl. in-browser .docx unzip)
src/typist.js       the human typing model
src/app.js          UI wiring and the run loop
tests/simulate.html offline simulator + self-tests (no Google account needed)
tests/fixture.docx  sample .docx for the extractor test
```

## A note on what this is for

This drafts and transcribes *your own* text into a Doc at a human pace — useful for getting a
long piece of writing into Docs with a natural edit history, or for drafting into Drive
without leaving the browser. Whether pacing an edit history that way is acceptable is between
you and whoever set the assignment; many schools treat disguising how work was produced as
academic misconduct.
