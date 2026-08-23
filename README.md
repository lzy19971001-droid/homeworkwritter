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

[`src/typist.js`](src/typist.js) holds the model and [`src/keyboard.js`](src/keyboard.js) the
key geometry. Timing is per keystroke, and the numbers come from Dhakal, Feit, Kristensson &
Oulasvirta, [*Observations on Typing from 136 Million
Keystrokes*](https://userinterfaces.aalto.fi/136Mkeystrokes/) (CHI 2018) — 136 million
keystrokes from 168,960 people — plus the earlier work it reviews:

| Finding | How it is used |
| --- | --- |
| Mean inter-key interval **238.66 ms** (SD 111.60) at **51.56 wpm** | The baseline interval, and the spread: CV ≈ 0.47 |
| The distribution is right-skewed | Intervals are drawn log-normally, not uniformly |
| Alternating hands beat same-hand pairs; same-finger pairs are ~80 ms slower than alternating | Per-transition cost from the QWERTY finger map |
| The left hand trails the right by 7–15 ms | +10 ms on left-hand keys |
| Error corrections are **6.3% of all keypresses** (2.29 per sentence) | Default error rate, and what the slider means |
| Insertion and omission errors outnumber substitutions for skilled typists | Error kinds are weighted 2:2:1:1 insert/omit/substitute/transpose |

On top of the per-key timing: hands warm up over the first couple of hundred characters and
tire slightly past three thousand; speed drifts between paragraphs; and pauses land at sentence
ends, paragraph breaks, occasionally mid-flow, and rarely as a several-second interruption.

**Errors are made and then noticed.** A slip is committed at a keystroke, typing carries on for
one to six more keys, and only then does the correction start — backspacing over everything
since and retyping it. Right after a correction the hands are more careful for a few keys.

### Keystroke timing, API traffic

One API request per keystroke would be roughly 300 requests a minute at 60 wpm, far past the
Docs quota. So the two are decoupled: **timing is per keystroke, traffic is per burst.** Each
keystroke gets its own interval; characters accumulate until about 1.6 seconds of typing has
built up, then go out as one `insertText`. A measured run: 181 keystrokes became 24 writes,
7.5 keys apiece.

Pass `granular: true` with a sink that costs nothing — a DOM node, a string — and every
keystroke and backspace lands separately. That is what the lab and the terminal script do.

The target speed is a steady-state rate: the average over a short passage comes out a little
below it, because the opening characters are slower. The time estimate models the same
envelope, so it does not come out optimistic.

The cursor position is tracked locally: a Doc body always ends with a newline that cannot be
deleted, so with *n* characters typed the body's end index is *n + 2*. If a delete ever fails,
the code re-reads the real length from the API and retries.

## Testing the typing locally

Two ways, neither needing a Google account.

### In a terminal — no server, no browser

```bash
python tests/typing.py
```

Types the sample text live in the terminal, backspacing over its own mistakes, then prints
whether the result matches the source and how it got there.

```
python tests/typing.py --speed 8            # eight times faster
python tests/typing.py --wpm 40 --typos 4   # slower, more error-prone
python tests/typing.py --file essay.txt     # your own text
python tests/typing.py --seed 7             # same run every time
python tests/typing.py --trace              # log every event instead of animating
python tests/typing.py --stats 200          # timing distribution over N runs
python tests/typing.py --check              # constants still match the JS?
```

`--trace` is the one to reach for when you want to see the mechanics:

```
0.00s  key        'T' 338ms     shift, so slow
0.00s  key        'h' 63ms      hands alternate, so quick
0.01s  error      insert 'a' before 'a'
0.01s  key        'a' 207ms
0.02s  pause      spotted-error 231ms
0.02s  backspace  -4
0.02s  fix        back to 7
```

`--stats N` types the text N times with no delays and reports the timing spread against the
study's own figures, which is how you check a change to the model did what you meant:

```
keystroke intervals mean  214.9 ms   SD 112.7   median  190.1
                    p10  102.1   p90  354.9   max 1214.2
study reference     mean 238.7 ms   SD 111.6  (at 51.6 wpm)
```

This script is a **port** of the model in [`src/typist.js`](src/typist.js), not a wrapper —
there is no JavaScript runtime involved. Ports drift, so every tunable number lives in one
`TUNING` block and `--check` reads `src/typist.js` to confirm they still agree:

```
$ python tests/typing.py --check
Constants have drifted from src/typist.js:

  - CADENCE_MS: typist.js has 1700, this script has 1600
```

Change the model on one side and `--check` tells you about the other. The exit code is
non-zero on a mismatch or a failed reconstruction, so it drops into CI as-is.

### In the browser — the lab

Serve the folder and open <http://localhost:8000/tests/lab.html>:

```bash
python -m http.server 8000
```

The Docs API is replaced with an in-page document, so the lab drives the real `typist.js`.
**Run** shows live metrics (modelled wpm, bursts, typos, immediate vs delayed fixes, pauses),
a rhythm strip where each bar is a burst and gold bars are pauses, and a timestamped trace.
**Time scale** compresses the waits up to 60x. **Self-test** sweeps four configurations across
four texts and asserts exact reconstruction. **Test .docx reader** checks the extractor.

Browsers throttle timers in hidden tabs, so keep the tab in front — in the background the
self-test takes minutes rather than seconds. The terminal script has no such problem.

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
tests/lab.html offline simulator + self-tests (no Google account needed)
tests/fixture.docx  sample .docx for the extractor test
```

## A note on what this is for

This drafts and transcribes *your own* text into a Doc at a human pace — useful for getting a
long piece of writing into Docs with a natural edit history, or for drafting into Drive
without leaving the browser. Whether pacing an edit history that way is acceptable is between
you and whoever set the assignment; many schools treat disguising how work was produced as
academic misconduct.
