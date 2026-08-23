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
- **Creates a new Doc** (optionally inside a Drive folder it creates for you), asking for
  only the narrow `drive.file` scope — it can never see the rest of your Drive.
- **Types it in like a human**: adjustable speed (15–140 wpm), typo rate, and how long it
  stops to "think" between sentences and paragraphs.
- **Pause / resume / stop** at any point; if a run fails or is stopped, pressing start again
  continues in the same document from where it left off.

Because every burst is a separate Docs API edit, the document's **version history in Google
Docs shows it being written over time** rather than appearing in one paste.

## Setup

**Who this section is for:** whoever deploys the app — once. The people who *use* your
deployment never see any of it. They press **Sign in with Google**, approve one permission,
and are done, exactly as on any other site with a Google button; returning visitors are
signed back in automatically without being asked again.

What you need is a Google OAuth **client ID**. It identifies your app to Google. It is public
information — safe to commit and safe to paste into the page.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create a project
   (or pick an existing one).
2. Enable the two APIs the app calls. These links open the enable page directly, which is
   easier than finding them in the Library — check the project picker in the top bar first,
   or you will enable them on the wrong project:
   - [Google Docs API](https://console.cloud.google.com/apis/library/docs.googleapis.com)
     (`docs.googleapis.com`)
   - [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
     (`drive.googleapis.com`)

   The button reads **Manage** once an API is on. Searching from **APIs & Services → Library**
   works too — but note that *Enabled APIs & services* is a different page that only lists
   what is already on, so searching there for an API you have not enabled yet finds nothing.
3. **APIs & Services → OAuth consent screen**:
   - User type **External** is fine.
   - Fill in app name and support email.
   - Add the scope `.../auth/drive.file` (plus `openid`, `email`, `profile`). All four are
     non-sensitive, so **no Google verification review is required**.
   - While the app is in **Testing**, add your own Google account under **Test users**.
     Only listed test users can sign in until you publish.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorised JavaScript origins** — add every origin the page will be loaded from.
     Scheme and host only: no path, no trailing slash, and HTTPS everywhere except localhost.
     - `https://homeworkwritter.com` — the live site
     - `http://localhost:8000` — local development
     - add `https://www.homeworkwritter.com` as well **only** if www serves the page rather
       than redirecting to the bare domain
   - **Leave "Authorised redirect URIs" empty.** Redirect URIs belong to the server-side
     authorisation-code flow. This app uses the browser token flow, where the token comes
     back through the sign-in popup and Google never redirects anywhere.
   - Origin changes can take a few minutes to take effect.
5. Copy the client ID (it ends in `.apps.googleusercontent.com`) and set `DEFAULT_CLIENT_ID`
   in [`src/config.js`](src/config.js), then commit and deploy. **Do this rather than pasting
   it into the box in the page** — the box is a fallback for trying the app out, and it only
   ever applies to the one browser you paste it into. With the ID baked in, nobody sees the
   box at all.

### Letting anyone sign in, not just you

While the consent screen sits in **Testing**, only the accounts listed under *Test users* can
sign in — up to 100 of them. That is the right setting for personal use.

To open it to anyone, go to the OAuth consent screen and press **Publish app**. Because every
scope this app requests is non-sensitive, there is no verification review to pass and no
"Google hasn't verified this app" warning — publishing takes effect immediately.

Publishing is also where the domain comes up a second time, on a different screen from the
origins above: the consent screen asks for an app homepage and a privacy policy URL, and wants
`homeworkwritter.com` listed under **Authorised domains**.

### "Error 403: access_denied" on sign-in

> *homeworkwritter.com has not completed the Google verification process. The app is currently
> being tested and can only be accessed by developer-approved testers.*

This is Testing mode, not a verification problem — the message says "verification" for every
app in Testing, whatever scopes it asks for. Either add the account under **Test users**, or
press **Publish app**; both are on the **Audience** page of the Google Auth Platform section
(**APIs & Services → OAuth consent screen** in the older console layout).

If it still fails after adding a test user, check which Google account the browser is actually
signed in as — the tester entry has to match that account exactly.

### Scopes, and why they are narrow

| Scope | What it allows | Google's classification |
| --- | --- | --- |
| `auth/drive.file` | See and manage **only the files this app creates** — not your existing Drive | Non-sensitive (recommended) |
| `openid`, `email`, `profile` | Show which account is signed in | Non-sensitive |

The obvious scope for this app would be `auth/documents`, but that one is **sensitive**: it
grants access to every Doc you own and puts the app through Google's verification review.
It is not requested. The Docs API accepts `drive.file` for documents the app created, so the
Doc is created through the Drive API — the app owns it, and can then type into it — and the
app remains entirely non-sensitive.

## Running it

It is static files, but it must be served over HTTP — ES modules and Google sign-in do not
work from `file://`.

```bash
python -m http.server 8000
```

Then open <http://localhost:8000> for the landing page, or
<http://localhost:8000/app.html> to go straight to the tool.

## Deploying

There is no build step — the repository *is* the site — so any free static host works.
Whichever you pick, the site must be served over **HTTPS**, and its origin must be listed in
your OAuth client's authorised JavaScript origins.

### GitHub Pages (already wired up)

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) publishes the site on every
push. Turn it on once:

**Settings → Pages → Source: GitHub Actions**

The next push (or **Actions → Deploy to GitHub Pages → Run workflow**) puts the site at
`https://<user>.github.io/<repo>/`.

### Netlify

[`netlify.toml`](netlify.toml) is included. At [app.netlify.com](https://app.netlify.com):
**Add new site → Import an existing project → GitHub → pick this repo → Deploy**. No build
command, publish directory `.`. You get a `*.netlify.app` domain with HTTPS.

### The one thing that catches people out

Google's **authorised JavaScript origins** field wants a bare origin — scheme and host only:

| Correct | Rejected |
| --- | --- |
| `https://you.github.io` | `https://you.github.io/homeworkwritter/` |
| `https://yoursite.netlify.app` | `https://yoursite.netlify.app/` |
| `http://localhost:8000` | `localhost:8000` |

No path, no trailing slash. The page can live at a sub-path; the *origin* is what is
registered.

## How the typing works

[`src/typist.js`](src/typist.js) holds the model.

- The engine writes through a **sink** — an object with `append`, `remove` and `length`. The
  app passes one backed by the Google Docs API; the landing page passes one backed by a
  `<div>`, which is why the demo in the hero is the real thing rather than a scripted
  animation.
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

Note that browsers throttle timers in hidden tabs, so leave the tab in front while a run is
going — in the background the same self-test takes minutes instead of seconds.

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
index.html          landing page
app.html            the tool itself
assets/landing.css  landing page styling
assets/styles.css   app styling
src/demo.js         hero demo — the real engine, typing into a <div>
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
