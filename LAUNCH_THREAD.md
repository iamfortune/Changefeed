# Changefeed launch thread

An X/Twitter-style launch thread announcing Changefeed to developers who have
never heard of Pear, Bare or Holepunch. Each post is under 280 characters.

---

**1/**

[![Changefeed, a Pear application (watch the demo)](https://cdn.loom.com/sessions/thumbnails/79f6f459a3e94c10bdde1d40f18273a1-34aa051369b1be19.gif)](https://www.loom.com/share/79f6f459a3e94c10bdde1d40f18273a1)

▶️ [Watch the demo](https://www.loom.com/share/79f6f459a3e94c10bdde1d40f18273a1)

Release notes live on servers. When the site's down or you're offline, they're gone.

I built Changefeed: release notes that go straight from maintainer to subscribers, peer to peer. No server, no account, works offline.

Here's how 🧵

---

**2/**

How it works:

1. A maintainer creates a feed and gets a key
2. You paste the key once
3. Every release note syncs to your machine, live

Quit the maintainer's app and you still have every note. Other subscribers can even serve them to you.

---

**3/**

It's built on Pear, an open-source platform from Holepunch for peer-to-peer apps.

Apps install from a pear:// link instead of an app store, and run on Bare, a small JavaScript runtime designed to run the same code on desktop, mobile and the command line.

---

**4/**

Under the hood:

- Hypercore: an append-only log signed by the maintainer, so every note is verified on arrival
- Hyperbee: a sorted key-value store on top, so newest-first is one range read
- Hyperswarm: peers find each other directly, no server

---

**5/**

Updates are peer to peer too. A new release is just an append to a Hypercore. Running copies of the app fetch it from peers and update over the air.

No app store. No update server. Decentralised all the way down.

---

**6/**

My favourite part: the backend doesn't know where it runs. The desktop app hosts it in a Bare worker; the CLI hosts the exact same file in a terminal. Mobile is next.

Lesson learned: Bare is its own runtime, so test on the exact version you ship.

---

**7/**

Try it:
Install: pear://7ffucmhbpa7z5hcao4t6435c6ndqryn38iu6nfzqwubqykap15yy
Code and docs: github.com/iamfortune/changefeed
3-min demo: loom.com/share/79f6f459a3e94c10bdde1d40f18273a1

If you've never built peer to peer, this is a good place to start.
