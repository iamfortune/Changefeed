import { cf } from './worker-client.js'

window.cf = cf // handy for poking at the backend from devtools

const $ = (id) => document.getElementById(id)

// ---- state ------------------------------------------------------------------

const state = {
  tab: 'publish',
  own: null, // feedInfo of the feed this device publishes, or null
  feeds: new Map(), // id -> feedInfo (followed feeds; never includes own)
  notes: new Map(), // id -> notes, newest first
  unread: new Map(), // id -> count of notes that arrived while not looking
  selected: null // followed feed shown in the subscriber view
}

function addNotes(id, incoming) {
  // Dedupe by createdAt: a note can arrive as an event and in a notes() read.
  const list = state.notes.get(id) || []
  const seen = new Set(list.map((n) => n.createdAt))
  for (const n of incoming) if (!seen.has(n.createdAt)) list.push(n)
  list.sort((a, b) => b.createdAt - a.createdAt)
  state.notes.set(id, list)
}

function setFeed(info) {
  if (info.writable) state.own = info
  else state.feeds.set(info.id, info)
}

function getFeed(id) {
  if (state.own && state.own.id === id) return state.own
  return state.feeds.get(id)
}

// ---- small DOM helpers ------------------------------------------------------

// Everything from peers is rendered with textContent, never innerHTML.
function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function shortKey(id) {
  return id.slice(0, 8) + '…' + id.slice(-6)
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function noteCard(note, fresh) {
  const card = el('article', fresh ? 'note fresh' : 'note')
  const head = el('div', 'note-head')
  head.append(
    el('span', 'note-version', note.version),
    el('span', 'note-title', note.title),
    el('time', 'note-date', dateFmt.format(note.createdAt))
  )
  card.append(head, el('p', 'note-body', note.body))
  return card
}

function renderNotes(container, id, freshAt, emptyText) {
  const notes = state.notes.get(id) || []
  container.replaceChildren(...notes.map((n) => noteCard(n, n.createdAt === freshAt)))
  if (notes.length === 0) container.append(el('div', 'empty muted', emptyText))
}

// v1.0.2: how many notes a feed holds, shown next to its status.
function renderCount(node, id) {
  const n = (state.notes.get(id) || []).length
  node.textContent = n === 1 ? '1 note' : `${n} notes`
}

function renderStatus(node, feed, hasNotes, { own }) {
  node.classList.remove('online', 'offline')
  if (feed.peers > 0) {
    node.classList.add('online')
    node.textContent = own
      ? `${feed.peers} peer${feed.peers === 1 ? '' : 's'} syncing`
      : `Connected to ${feed.peers} peer${feed.peers === 1 ? '' : 's'}`
  } else if (own) {
    node.textContent = 'No subscribers online'
  } else if (hasNotes) {
    node.classList.add('offline')
    node.textContent = 'Offline: showing saved notes'
  } else {
    node.textContent = 'Looking for peers…'
  }
}

// ---- render -----------------------------------------------------------------

function renderTabs() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === state.tab))
  }
  $('view-publish').hidden = state.tab !== 'publish'
  $('view-subscribe').hidden = state.tab !== 'subscribe'

  let unread = 0
  for (const n of state.unread.values()) unread += n
  $('unread-total').hidden = unread === 0
  $('unread-total').textContent = unread
}

function renderPublish(freshAt) {
  const own = state.own
  $('create-feed').hidden = !!own
  $('own-feed').hidden = !own
  if (!own) return

  $('own-name').textContent = own.name
  $('own-key').textContent = own.id
  renderStatus($('own-peers'), own, false, { own: true })
  renderCount($('own-count'), own.id)
  renderNotes($('own-notes'), own.id, freshAt, 'Nothing published yet.')

  // v1.0.1: suggest the next patch version so publishing is one less step.
  if (!$('note-version').value) $('note-version').value = nextVersion(own.id)
}

// '1.4.2' → '1.4.3'. Anything that isn't x.y.z is left for the user to type.
function nextVersion(id) {
  const latest = (state.notes.get(id) || [])[0]
  if (!latest) return '1.0.0'
  const m = latest.version.match(/^v?(\d+)\.(\d+)\.(\d+)$/)
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : ''
}

function renderSubscribe(freshAt) {
  const feeds = [...state.feeds.values()]
  $('no-subs').hidden = feeds.length > 0
  $('subs').hidden = feeds.length === 0
  if (feeds.length === 0) return

  if (!state.feeds.has(state.selected)) state.selected = feeds[0].id
  if (state.tab === 'subscribe') state.unread.delete(state.selected)

  $('feed-list').replaceChildren(
    ...feeds.map((feed) => {
      const item = el('button', 'feed-item' + (feed.id === state.selected ? ' selected' : ''))
      item.type = 'button'
      const dot = el('span', 'status' + (feed.peers > 0 ? ' online' : ''))
      item.append(dot, el('span', 'feed-item-name', feed.name || shortKey(feed.id)))
      const unread = state.unread.get(feed.id)
      if (unread) item.append(el('span', 'badge', String(unread)))
      item.onclick = () => {
        state.selected = feed.id
        render()
      }
      return item
    })
  )

  const feed = state.feeds.get(state.selected)
  const notes = state.notes.get(feed.id) || []
  $('sub-name').textContent = feed.name || 'Waiting for feed ' + shortKey(feed.id)
  renderStatus($('sub-peers'), feed, notes.length > 0, { own: false })
  renderCount($('sub-count'), feed.id)
  renderNotes(
    $('sub-notes'),
    feed.id,
    freshAt,
    feed.peers > 0 ? 'Syncing notes…' : 'No notes yet. They will appear once a peer is found.'
  )
}

function render(freshAt) {
  renderSubscribe(freshAt)
  renderTabs()
  renderPublish(freshAt)
}

// ---- actions ----------------------------------------------------------------

for (const tab of document.querySelectorAll('.tab')) {
  tab.onclick = () => {
    state.tab = tab.dataset.tab
    render()
  }
}

$('create-form').onsubmit = async (e) => {
  e.preventDefault()
  const info = await cf.createFeed($('feed-name').value.trim())
  setFeed(info)
  addNotes(info.id, await cf.notes(info.id))
  render()
  $('note-version').focus()
}

$('copy-key').onclick = async () => {
  await navigator.clipboard.writeText(state.own.id)
  $('copy-key').textContent = 'Copied'
  setTimeout(() => ($('copy-key').textContent = 'Copy'), 1500)
}

async function publish() {
  const btn = $('publish-form').querySelector('button')
  $('publish-error').textContent = ''
  btn.disabled = true
  try {
    await cf.publish({
      version: $('note-version').value,
      title: $('note-title').value,
      body: $('note-body').value
    })
    // The note itself comes back as a 'note' event, same path as remote notes.
    $('publish-form').reset()
    $('note-version').focus()
  } catch (err) {
    $('publish-error').textContent = err.message
  } finally {
    btn.disabled = false
  }
}

$('publish-form').onsubmit = (e) => {
  e.preventDefault()
  publish()
}
$('publish-form').onkeydown = (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) publish()
}

$('subscribe-form').onsubmit = async (e) => {
  e.preventDefault()
  $('subscribe-error').textContent = ''
  const key = $('sub-key').value.trim()
  if (!key) return
  try {
    const info = await cf.subscribe(key)
    if (info.writable) throw new Error("That's your own feed. See the Publish tab.")
    setFeed(info)
    addNotes(info.id, await cf.notes(info.id))
    state.selected = info.id
    $('sub-key').value = ''
    render()
  } catch (err) {
    $('subscribe-error').textContent = err.message
  }
}

// ---- events from the worker -------------------------------------------------

cf.on('note', ({ feed, note }) => {
  addNotes(feed, [note])
  const isOwn = state.own && state.own.id === feed
  const viewing = state.tab === 'subscribe' && state.selected === feed
  if (!isOwn && !viewing) state.unread.set(feed, (state.unread.get(feed) || 0) + 1)
  render(note.createdAt)
})

cf.on('feed', (info) => {
  setFeed(info)
  render()
})

cf.on('peers', ({ feed, peers }) => {
  const info = getFeed(feed)
  if (!info) return
  info.peers = peers
  render()
})

cf.on('exit', () => {
  $('error-banner').textContent = 'The P2P backend stopped. Restart the app.'
  $('error-banner').hidden = false
})

// ---- OTA updates (driven by the template's updater messages) ---------------

function showUpdate(message) {
  const banner = $('update-banner')
  const btn = $('update-btn')
  if (message === 'updating') {
    banner.hidden = false
    btn.hidden = true
    $('update-text').textContent = 'Downloading an update from peers…'
  } else if (message === 'updated') {
    banner.hidden = false
    btn.hidden = false
    $('update-text').textContent = 'Update ready.'
  }
}

cf.on('updater', showUpdate)

$('update-btn').onclick = async () => {
  const btn = $('update-btn')
  btn.disabled = true
  btn.textContent = 'Restarting…'
  try {
    await cf.applyUpdate()
    await cf.appAfterUpdate()
  } catch (err) {
    $('update-text').textContent = 'Update failed: ' + err.message
    btn.hidden = true
  }
}

// ---- boot -------------------------------------------------------------------

$('version').textContent = 'v' + cf.version

async function boot() {
  const { own, feeds, update } = await cf.init()
  // A window opened after the updater event still shows the banner.
  if (update) showUpdate(update)
  for (const info of [own, ...feeds].filter(Boolean)) {
    setFeed(info)
    addNotes(info.id, await cf.notes(info.id))
  }
  // Land where the user has something: their feed, else what they follow.
  state.tab = own || state.feeds.size === 0 ? 'publish' : 'subscribe'
  render()
}

boot().catch((err) => {
  $('error-banner').textContent = 'Failed to start: ' + err.message
  $('error-banner').hidden = false
})
