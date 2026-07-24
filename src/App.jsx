import { useState, useEffect, useRef, useCallback } from "react";
import * as XLSX from "xlsx";
import Papa from "papaparse";
import { Upload, Plus, Pencil, Trash2, ArrowLeftRight, X, Check, ChevronRight, BookOpen, Home as HomeIcon, BarChart3, Settings as SettingsIcon, Volume2 } from "lucide-react";
import { doc, getDoc, setDoc, deleteDoc, collection, getDocs } from "firebase/firestore";
import { db } from "./firebase";

// ---------- Constants ----------
const BOX_INTERVALS = [1, 1, 2, 4, 8, 16]; // index = box number (0 = MC stage)
const TROUBLE_THRESHOLD = 3;
const DIACRITIC_REGEX = /[\u064B-\u0652\u0670\u0640]/g;
const ARABIC_KEYS_LETTERS = [
  "ا","ب","ت","ث","ج","ح","خ","د","ذ","ر","ز","س","ش","ص","ض",
  "ط","ظ","ع","غ","ف","ق","ك","ل","م","ن","ه","و","ي","ة","ء","ى","ئ","ؤ","إ","أ","آ"
];
const ARABIC_KEYS_DIACRITICS = [
  { ch: "َ", label: "fatḥa" },
  { ch: "ِ", label: "kasra" },
  { ch: "ُ", label: "ḍamma" },
  { ch: "ْ", label: "sukūn" },
  { ch: "ّ", label: "shadda" },
  { ch: "ً", label: "tanwīn-a" },
  { ch: "ٍ", label: "tanwīn-i" },
  { ch: "ٌ", label: "tanwīn-u" },
];

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function stripDiacritics(s) {
  return (s || "").replace(DIACRITIC_REGEX, "").replace(/\s+/g, " ").trim();
}
function normalizeAr(s) {
  return (s || "").trim().replace(/\s+/g, " ");
}
function normalizeEn(s) {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function keyForName(name) {
  return "student:" + name.trim().toLowerCase();
}

function freshWord(en, ar, notes = "") {
  return {
    id: uid(),
    en: en.trim(),
    ar: ar.trim(),
    notes: notes.trim(),
    box: 0,
    correctStreak: 0,
    totalWrong: 0,
    totalCorrect: 0,
    mastered: false,
    trouble: false,
    dueSession: 0,
    lastCorrectAtMax: false,
  };
}

// Shared-deck words store only content (no per-user progress).
function freshContentWord(en, ar, notes = "") {
  return { id: uid(), en: en.trim(), ar: ar.trim(), notes: notes.trim() };
}

function freshProgress() {
  return {
    box: 0,
    correctStreak: 0,
    totalWrong: 0,
    totalCorrect: 0,
    mastered: false,
    trouble: false,
    dueSession: 0,
    lastCorrectAtMax: false,
  };
}

function freshDeck(name) {
  return { id: uid(), name, words: [] };
}

function freshSharedDeck(name, createdBy) {
  return { id: uid(), name, createdBy, createdAt: Date.now(), words: [] };
}

function freshUser(name) {
  return {
    name,
    createdAt: Date.now(),
    sessionCount: 0,
    decks: [freshDeck("My First Deck")],
    sharedProgress: {}, // { [sharedDeckId]: { [wordId]: progress } }
    settings: { direction: "en-ar", strictness: "letters", answerMode: "mixed", sessionSize: 40 },
    history: [], // session summaries
  };
}

// ---------- Storage (Firestore) ----------
// Students are stored in a "students" collection, one doc per name.
// Shared decks are stored in a "sharedDecks" collection, one doc per deck.
async function loadUser(name) {
  try {
    const ref = doc(db, "students", keyForName(name));
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    return snap.data().payload ? JSON.parse(snap.data().payload) : null;
  } catch (e) {
    console.error("load user failed", e);
    return null;
  }
}
async function saveUser(user) {
  try {
    const ref = doc(db, "students", keyForName(user.name));
    await setDoc(ref, { payload: JSON.stringify(user), updatedAt: Date.now() });
  } catch (e) {
    console.error("save failed", e);
  }
}

function sharedDeckKey(id) {
  return id;
}
async function loadSharedDecks() {
  try {
    const snap = await getDocs(collection(db, "sharedDecks"));
    const decks = [];
    snap.forEach((d) => {
      try {
        decks.push(JSON.parse(d.data().payload));
      } catch (e) { /* skip unreadable entry */ }
    });
    decks.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    return decks;
  } catch (e) {
    console.error("load shared decks failed", e);
    return [];
  }
}
async function saveSharedDeck(deck) {
  try {
    const ref = doc(db, "sharedDecks", sharedDeckKey(deck.id));
    await setDoc(ref, { payload: JSON.stringify(deck), updatedAt: Date.now() });
  } catch (e) {
    console.error("shared deck save failed", e);
  }
}
async function deleteSharedDeckRemote(id) {
  try {
    await deleteDoc(doc(db, "sharedDecks", sharedDeckKey(id)));
  } catch (e) {
    console.error("shared deck delete failed", e);
  }
}

// ---------- App ----------
export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(false);
  const [screen, setScreen] = useState("home"); // home | decks | study | stats | settings
  const [studyConfig, setStudyConfig] = useState(null);
  const [sharedDecks, setSharedDecks] = useState([]);
  const saveTimer = useRef(null);

  const refreshSharedDecks = useCallback(async () => {
    const decks = await loadSharedDecks();
    setSharedDecks(decks);
  }, []);

  useEffect(() => {
    if (user) refreshSharedDecks();
  }, [user?.name]);

  // debounce-ish save whenever user changes
  useEffect(() => {
    if (!user) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveUser(user), 250);
    return () => clearTimeout(saveTimer.current);
  }, [user]);

  if (!user) {
    return <NameGate onEnter={async (name) => {
      setLoading(true);
      let u = await loadUser(name);
      if (!u) u = freshUser(name);
      if (!u.sharedProgress) u.sharedProgress = {};
      if (!u.settings.answerMode) u.settings.answerMode = "mixed";
      if (!u.settings.sessionSize) u.settings.sessionSize = 40;
      setLoading(false);
      setUser(u);
    }} loading={loading} />;
  }

  return (
    <div className="avapp">
      <style>{CSS}</style>
      <TopBar name={user.name} onSwitch={() => setUser(null)} />
      <div className="avapp-body">
        {screen === "home" && (
          <HomeScreen
            user={user}
            setUser={setUser}
            sharedDecks={sharedDecks}
            onStudy={(cfg) => { setStudyConfig(cfg); setScreen("study"); }}
            onGoDecks={() => setScreen("decks")}
          />
        )}
        {screen === "decks" && (
          <DeckManager
            user={user}
            setUser={setUser}
            sharedDecks={sharedDecks}
            refreshSharedDecks={refreshSharedDecks}
            onStudy={(cfg) => { setStudyConfig(cfg); setScreen("study"); }}
            onBack={() => setScreen("home")}
          />
        )}
        {screen === "study" && studyConfig && (
          <StudySession
            user={user}
            setUser={setUser}
            sharedDecks={sharedDecks}
            config={studyConfig}
            onFinish={() => { setScreen("home"); setStudyConfig(null); }}
          />
        )}
        {screen === "stats" && <StatsScreen user={user} sharedDecks={sharedDecks} onBack={() => setScreen("home")} />}
        {screen === "settings" && (
          <SettingsScreen user={user} setUser={setUser} onBack={() => setScreen("home")} />
        )}
      </div>
      <BottomNav screen={screen} setScreen={setScreen} />
    </div>
  );
}

// ---------- Name Gate ----------
function NameGate({ onEnter, loading }) {
  const [name, setName] = useState("");
  return (
    <div className="gate">
      <style>{CSS}</style>
      <div className="gate-card">
        <div className="gate-mark">﷼‌</div>
        <div className="gate-title">مُفْرَدات</div>
        <div className="gate-sub">Seekers Light Arabic Vocab Builder</div>
        <p className="gate-copy">Enter your name to start, or pick up right where you left off.</p>
        <input
          className="gate-input"
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onEnter(name.trim()); }}
          autoFocus
        />
        <button className="btn btn-gold" disabled={!name.trim() || loading} onClick={() => onEnter(name.trim())}>
          {loading ? "Loading…" : "Continue"}
        </button>
        <div className="gate-note">No password needed. Using the same name brings back your saved progress from any device.</div>
      </div>
    </div>
  );
}

function TopBar({ name, onSwitch }) {
  return (
    <div className="topbar">
      <div className="topbar-title">مُفْرَدات <span className="topbar-sub">Seekers Light</span></div>
      <div className="topbar-user">
        <span>{name}</span>
        <button className="linklike" onClick={onSwitch}>switch user</button>
      </div>
    </div>
  );
}

function BottomNav({ screen, setScreen }) {
  const items = [
    { id: "home", label: "Home", Icon: HomeIcon },
    { id: "decks", label: "Decks", Icon: BookOpen },
    { id: "stats", label: "Stats", Icon: BarChart3 },
    { id: "settings", label: "Settings", Icon: SettingsIcon },
  ];
  return (
    <div className="bottomnav">
      {items.map(({ id, label, Icon }) => (
        <button key={id} className={"nav-btn" + (screen === id ? " active" : "")} onClick={() => setScreen(id)}>
          <Icon size={20} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

// ---------- Home ----------
function allWords(user, sharedDecks = []) {
  const personal = user.decks.flatMap((d) =>
    d.words.map((w) => ({ ...w, deckId: d.id, deckName: d.name, source: "personal" }))
  );
  const shared = sharedDecks.flatMap((d) =>
    d.words.map((w) => {
      const progress = user.sharedProgress?.[d.id]?.[w.id] || freshProgress();
      return { ...w, ...progress, deckId: d.id, deckName: d.name, source: "shared" };
    })
  );
  return [...personal, ...shared];
}
function boxCounts(user, sharedDecks = []) {
  const counts = [0, 0, 0, 0, 0, 0];
  let mastered = 0;
  allWords(user, sharedDecks).forEach((w) => {
    if (w.mastered) mastered++;
    else counts[w.box] = (counts[w.box] || 0) + 1;
  });
  return { counts, mastered };
}
function dueWords(user, sharedDecks = [], deckIds = null) {
  const s = user.sessionCount;
  const ids = deckIds ? (Array.isArray(deckIds) ? deckIds : [deckIds]) : null;
  return allWords(user, sharedDecks).filter(
    (w) => !w.mastered && w.dueSession <= s && (ids ? ids.includes(w.deckId) : true)
  );
}
function troubleWords(user, sharedDecks = [], deckIds = null) {
  const ids = deckIds ? (Array.isArray(deckIds) ? deckIds : [deckIds]) : null;
  return allWords(user, sharedDecks).filter((w) => w.trouble && (ids ? ids.includes(w.deckId) : true));
}

function HomeScreen({ user, setUser, sharedDecks, onStudy, onGoDecks }) {
  const { counts, mastered } = boxCounts(user, sharedDecks);
  const totalWords = allWords(user, sharedDecks).length;
  const due = dueWords(user, sharedDecks);
  const trouble = troubleWords(user, sharedDecks);
  const maxCount = Math.max(1, ...counts);
  const [selectedDeckIds, setSelectedDeckIds] = useState([]);

  function toggleDeckSelected(id) {
    setSelectedDeckIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const selectedDue = dueWords(user, sharedDecks, selectedDeckIds).length;
  const selectedTrouble = troubleWords(user, sharedDecks, selectedDeckIds).length;

  return (
    <div className="screen">
      <div className="card hero">
        <div className="hero-eyebrow">Welcome back</div>
        <div className="hero-name">{user.name}</div>
        <div className="hero-stats">
          <div><b>{totalWords}</b> words</div>
          <div><b>{mastered}</b> mastered</div>
          <div><b>{due.length}</b> due now</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Leitner shelf</div>
        <div className="hint">Each box is a review stage. Get a word right and it moves up a box, reviewed less often; get it wrong and it drops back to box 1. Reach the top box twice in a row and it's "mastered."</div>
        <div className="shelf">
          <div className="shelf-row mastered-row">
            <div className="shelf-label">mastered</div>
            <div className="shelf-track">
              <div className="shelf-fill mastered-fill" style={{ width: `${(mastered / maxCount) * 100}%` }} />
            </div>
            <div className="shelf-count">{mastered}</div>
          </div>
          {counts.map((c, i) => i).reverse().map((i) => {
            const c = counts[i];
            return (
              <div className="shelf-row" key={i}>
                <div className="shelf-label">{i === 0 ? "new" : `box ${i}`}</div>
                <div className="shelf-track">
                  <div className="shelf-fill" style={{ width: `${(c / maxCount) * 100}%` }} />
                </div>
                <div className="shelf-count">{c}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid2">
        <button
          className="btn btn-gold big"
          disabled={due.length === 0}
          onClick={() => onStudy({ source: "due", deckIds: null })}
        >
          Study all due ({due.length})
        </button>
        <button
          className="btn btn-outline big"
          disabled={trouble.length === 0}
          onClick={() => onStudy({ source: "trouble", deckIds: null })}
        >
          Practice all trouble ({trouble.length})
        </button>
      </div>

      <div className="card">
        <div className="card-title">Study selected decks</div>
        <div className="hint">
          {selectedDeckIds.length === 0
            ? "Tick one deck to study it alone, or several to combine them into one session."
            : `${selectedDeckIds.length} deck${selectedDeckIds.length > 1 ? "s" : ""} selected.`}
        </div>
        <div className="grid2">
          <button
            className="btn btn-gold"
            disabled={selectedDeckIds.length === 0 || selectedDue === 0}
            onClick={() => onStudy({ source: "due", deckIds: selectedDeckIds })}
          >
            Study due ({selectedDue})
          </button>
          <button
            className="btn btn-outline"
            disabled={selectedDeckIds.length === 0 || selectedTrouble === 0}
            onClick={() => onStudy({ source: "trouble", deckIds: selectedDeckIds })}
          >
            Practice trouble ({selectedTrouble})
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-title-row">
          <div className="card-title">Shared decks</div>
          <button className="linklike" onClick={onGoDecks}>manage <ChevronRight size={14} /></button>
        </div>
        {sharedDecks.length === 0 && <div className="empty">No shared decks yet. Anyone can upload one from Decks → Shared.</div>}
        {sharedDecks.map((d) => {
          const dDue = dueWords(user, sharedDecks, d.id).length;
          return (
            <label className="multi-deck-row" key={d.id}>
              <input type="checkbox" checked={selectedDeckIds.includes(d.id)} onChange={() => toggleDeckSelected(d.id)} />
              <span>{d.name} <span className="badge badge-gold">shared</span></span>
              <span className="deck-meta">{d.words.length} words · {dDue} due</span>
            </label>
          );
        })}
      </div>

      <div className="card">
        <div className="card-title-row">
          <div className="card-title">My decks</div>
          <button className="linklike" onClick={onGoDecks}>manage <ChevronRight size={14} /></button>
        </div>
        {user.decks.length === 0 && <div className="empty">No decks yet. Add one to get started.</div>}
        {user.decks.map((d) => {
          const dDue = dueWords(user, sharedDecks, d.id).length;
          return (
            <label className="multi-deck-row" key={d.id}>
              <input type="checkbox" checked={selectedDeckIds.includes(d.id)} onChange={() => toggleDeckSelected(d.id)} />
              <span>{d.name}</span>
              <span className="deck-meta">{d.words.length} words · {dDue} due</span>
            </label>
          );
        })}
      </div>

      {totalWords === 0 && (
        <div className="card callout">
          <div className="card-title">Get started</div>
          <p>Head to Decks to upload a CSV/XLSX word list, or add words by hand.</p>
          <button className="btn btn-gold" onClick={onGoDecks}>Go to Decks</button>
        </div>
      )}
    </div>
  );
}

function isSakib(name) {
  return (name || "").trim().toLowerCase() === "sakib";
}

function ConfirmDialog({ message, onConfirm, onCancel }) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-title">Please confirm</div>
        <p className="confirm-message">{message}</p>
        <div className="grid2">
          <button className="btn btn-outline" onClick={onCancel}>Cancel</button>
          <button className="btn btn-gold" onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  );
}

function RenameDeckModal({ initialName, onCancel, onSave }) {
  const [name, setName] = useState(initialName);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-title">Rename deck</div>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && onSave(name)}
          autoFocus
        />
        <div className="grid2">
          <button className="btn btn-outline" onClick={onCancel}>Cancel</button>
          <button className="btn btn-gold" disabled={!name.trim()} onClick={() => onSave(name)}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Deck Manager ----------
function parseRows(rows) {
  // rows: array of objects or arrays. Try to find English/Arabic columns.
  const words = [];
  for (const row of rows) {
    let en, ar, notes = "";
    if (Array.isArray(row)) {
      en = row[0]; ar = row[1]; notes = row[2] || "";
    } else {
      const keys = Object.keys(row);
      const enKey = keys.find((k) => /^en(glish)?$/i.test(k.trim())) || keys[0];
      const arKey = keys.find((k) => /^ar(abic)?$/i.test(k.trim())) || keys[1];
      const noteKey = keys.find((k) => /notes?|category|note/i.test(k.trim()));
      en = row[enKey]; ar = row[arKey]; notes = noteKey ? row[noteKey] : "";
    }
    if (en && ar && String(en).trim() && String(ar).trim()) {
      words.push(freshWord(String(en), String(ar), String(notes || "")));
    }
  }
  return words;
}

function DeckManager({ user, setUser, sharedDecks, refreshSharedDecks, onStudy, onBack }) {
  const [scope, setScope] = useState("personal"); // personal | shared
  const [activeDeckId, setActiveDeckId] = useState(user.decks[0]?.id || null);
  const [activeSharedId, setActiveSharedId] = useState(sharedDecks[0]?.id || null);
  const [newDeckName, setNewDeckName] = useState("");
  const [showAddWord, setShowAddWord] = useState(false);
  const [editWord, setEditWord] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null); // { message, action }
  const [renamingDeck, setRenamingDeck] = useState(null); // { id, currentName, scope }
  const fileRef = useRef(null);

  useEffect(() => { refreshSharedDecks(); }, []);

  const activeDeck = user.decks.find((d) => d.id === activeDeckId);
  const activeShared = sharedDecks.find((d) => d.id === activeSharedId);
  const canManageShared = isSakib(user.name);
  const isOwner = canManageShared;

  function updateUser(fn) {
    setUser((u) => {
      const copy = JSON.parse(JSON.stringify(u));
      fn(copy);
      return copy;
    });
  }

  // ----- Personal deck actions -----
  function addDeck() {
    if (!newDeckName.trim()) return;
    updateUser((u) => {
      const d = freshDeck(newDeckName.trim());
      u.decks.push(d);
      setActiveDeckId(d.id);
    });
    setNewDeckName("");
  }
  function deleteDeck(id) {
    setConfirmDelete({
      message: "Delete this deck and all its words? This can't be undone.",
      action: () => {
        updateUser((u) => { u.decks = u.decks.filter((d) => d.id !== id); });
        if (activeDeckId === id) setActiveDeckId(null);
        setConfirmDelete(null);
      },
    });
  }
  function renameDeck(id, newName) {
    if (!newName.trim()) return;
    updateUser((u) => {
      const d = u.decks.find((x) => x.id === id);
      if (d) d.name = newName.trim();
    });
  }

  // ----- Shared deck actions -----
  async function addSharedDeck() {
    if (!canManageShared || !newDeckName.trim()) return;
    const d = freshSharedDeck(newDeckName.trim(), user.name);
    await saveSharedDeck(d);
    await refreshSharedDecks();
    setActiveSharedId(d.id);
    setNewDeckName("");
  }
  async function deleteSharedDeckAction(deck) {
    if (!canManageShared) return;
    setConfirmDelete({
      message: `Delete "${deck.name}" for everyone? This can't be undone.`,
      action: async () => {
        await deleteSharedDeckRemote(deck.id);
        await refreshSharedDecks();
        if (activeSharedId === deck.id) setActiveSharedId(null);
        setConfirmDelete(null);
      },
    });
  }
  async function renameSharedDeck(deck, newName) {
    if (!canManageShared || !newName.trim()) return;
    await saveSharedDeck({ ...deck, name: newName.trim() });
    await refreshSharedDecks();
  }

  function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const ext = file.name.split(".").pop().toLowerCase();

    const onParsed = async (words) => {
      if (scope === "personal") {
        if (!activeDeck) return;
        updateUser((u) => {
          const d = u.decks.find((x) => x.id === activeDeckId);
          d.words.push(...words.map((w) => freshWord(w.en, w.ar, w.notes)));
        });
      } else {
        if (!activeShared || !isOwner) return;
        const updated = { ...activeShared, words: [...activeShared.words, ...words.map((w) => freshContentWord(w.en, w.ar, w.notes))] };
        await saveSharedDeck(updated);
        await refreshSharedDecks();
      }
    };

    if (ext === "csv") {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (res) => onParsed(parseRows(res.data)),
      });
    } else {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const wb = XLSX.read(ev.target.result, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
        onParsed(parseRows(rows));
      };
      reader.readAsArrayBuffer(file);
    }
    e.target.value = "";
  }

  function deleteWord(wid) {
    if (scope === "personal") {
      updateUser((u) => {
        const d = u.decks.find((x) => x.id === activeDeckId);
        d.words = d.words.filter((w) => w.id !== wid);
      });
    } else if (isOwner) {
      const updated = { ...activeShared, words: activeShared.words.filter((w) => w.id !== wid) };
      saveSharedDeck(updated).then(refreshSharedDecks);
    }
  }

  function saveWord(word) {
    if (scope === "personal") {
      updateUser((u) => {
        const d = u.decks.find((x) => x.id === activeDeckId);
        const idx = d.words.findIndex((w) => w.id === word.id);
        if (idx >= 0) d.words[idx] = { ...d.words[idx], en: word.en, ar: word.ar, notes: word.notes };
        else d.words.push(freshWord(word.en, word.ar, word.notes));
      });
    } else if (isOwner) {
      const idx = activeShared.words.findIndex((w) => w.id === word.id);
      const words = [...activeShared.words];
      if (idx >= 0) words[idx] = { ...words[idx], en: word.en, ar: word.ar, notes: word.notes };
      else words.push(freshContentWord(word.en, word.ar, word.notes));
      saveSharedDeck({ ...activeShared, words }).then(refreshSharedDecks);
    }
    setShowAddWord(false);
    setEditWord(null);
  }

  const displayDeck = scope === "personal" ? activeDeck : activeShared;
  const canEditContent = scope === "personal" || isOwner;

  return (
    <div className="screen">
      <div className="row-header">
        <button className="linklike" onClick={onBack}>← back</button>
      </div>

      <div className="card">
        <div className="toggle-row">
          <button className={"toggle-opt" + (scope === "personal" ? " active" : "")} onClick={() => setScope("personal")}>
            My decks
          </button>
          <button className={"toggle-opt" + (scope === "shared" ? " active" : "")} onClick={() => setScope("shared")}>
            Shared decks
          </button>
        </div>

        {scope === "shared" && (
          <div className="hint">
            {canManageShared
              ? "Shared decks are visible to everyone who uses this app. As the deck manager, you can add, edit, and delete shared decks and their words."
              : "Shared decks are visible to everyone. Only Sakib can add, edit, or delete shared decks — everyone else can study them."}
          </div>
        )}

        <div className="deck-chip-row">
          {scope === "personal"
            ? user.decks.map((d) => (
                <button key={d.id} className={"deck-chip" + (d.id === activeDeckId ? " active" : "")} onClick={() => setActiveDeckId(d.id)}>
                  {d.name} <span className="chip-count">{d.words.length}</span>
                </button>
              ))
            : sharedDecks.map((d) => (
                <button key={d.id} className={"deck-chip" + (d.id === activeSharedId ? " active" : "")} onClick={() => setActiveSharedId(d.id)}>
                  {d.name} <span className="chip-count">{d.words.length}</span>
                </button>
              ))}
        </div>

        {(scope === "personal" || canManageShared) && (
          <div className="new-deck-row">
            <input
              className="input"
              placeholder={scope === "personal" ? "New deck name (e.g. Chapter 3)" : "New shared deck name"}
              value={newDeckName}
              onChange={(e) => setNewDeckName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (scope === "personal" ? addDeck() : addSharedDeck())}
            />
            <button className="btn btn-gold btn-small" onClick={scope === "personal" ? addDeck : addSharedDeck}>
              <Plus size={16} />
            </button>
          </div>
        )}
      </div>

      {displayDeck && (
        <div className="card">
          <div className="card-title-row">
            <div className="card-title">
              {displayDeck.name}
              {scope === "shared" && <span className="badge badge-gold" style={{ marginLeft: 8 }}>by {displayDeck.createdBy}</span>}
            </div>
            {(scope === "personal" || isOwner) && (
              <div className="deck-header-actions">
                <button
                  className="linklike"
                  onClick={() => setRenamingDeck({ id: displayDeck.id, currentName: displayDeck.name, scope })}
                >
                  <Pencil size={14} /> rename
                </button>
                <button
                  className="linklike danger"
                  onClick={() => (scope === "personal" ? deleteDeck(displayDeck.id) : deleteSharedDeckAction(displayDeck))}
                >
                  <Trash2 size={14} /> delete deck
                </button>
              </div>
            )}
          </div>

          {canEditContent && (
            <>
              <div className="grid2">
                <button className="btn btn-outline" onClick={() => fileRef.current.click()}>
                  <Upload size={16} /> Upload CSV/XLSX
                </button>
                <button className="btn btn-outline" onClick={() => setShowAddWord(true)}>
                  <Plus size={16} /> Add word manually
                </button>
              </div>
              <input type="file" accept=".csv,.xlsx,.xls" ref={fileRef} style={{ display: "none" }} onChange={handleFile} />
              <div className="hint">Columns: English, Arabic (with vowels), Notes (optional). Header names are auto-detected.</div>
            </>
          )}
          {!canEditContent && (
            <div className="hint">You can study this deck, but only {displayDeck.createdBy} can add or edit its words.</div>
          )}

          <div className="word-list">
            {displayDeck.words.length === 0 && <div className="empty">No words in this deck yet.</div>}
            {displayDeck.words.map((w) => {
              const progress = scope === "shared" ? (user.sharedProgress?.[displayDeck.id]?.[w.id] || freshProgress()) : w;
              return (
                <div className="word-row" key={w.id}>
                  <div className="word-en">{w.en}</div>
                  <div className="word-ar" dir="rtl">{w.ar}</div>
                  <div className="word-badges">
                    {progress.mastered && <span className="badge badge-gold">mastered</span>}
                    {!progress.mastered && <span className="badge">box {progress.box}</span>}
                    {progress.trouble && <span className="badge badge-red">trouble</span>}
                  </div>
                  <div className="word-actions">
                    {canEditContent && <button className="icon-btn" onClick={() => setEditWord(w)}><Pencil size={14} /></button>}
                    {canEditContent && <button className="icon-btn" onClick={() => deleteWord(w.id)}><Trash2 size={14} /></button>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {(showAddWord || editWord) && (
        <WordModal
          initial={editWord}
          onCancel={() => { setShowAddWord(false); setEditWord(null); }}
          onSave={saveWord}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          message={confirmDelete.message}
          onConfirm={confirmDelete.action}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {renamingDeck && (
        <RenameDeckModal
          initialName={renamingDeck.currentName}
          onCancel={() => setRenamingDeck(null)}
          onSave={(newName) => {
            if (renamingDeck.scope === "personal") {
              renameDeck(renamingDeck.id, newName);
            } else {
              const deck = sharedDecks.find((d) => d.id === renamingDeck.id);
              if (deck) renameSharedDeck(deck, newName);
            }
            setRenamingDeck(null);
          }}
        />
      )}
    </div>
  );
}

function WordModal({ initial, onCancel, onSave }) {
  const [en, setEn] = useState(initial?.en || "");
  const [ar, setAr] = useState(initial?.ar || "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const arRef = useRef(null);

  function insertChar(ch) {
    const el = arRef.current;
    if (!el) { setAr((a) => a + ch); return; }
    const start = el.selectionStart ?? ar.length;
    const end = el.selectionEnd ?? ar.length;
    const next = ar.slice(0, start) + ch + ar.slice(end);
    setAr(next);
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = start + ch.length; });
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title-row">
          <div className="card-title">{initial ? "Edit word" : "Add word"}</div>
          <button className="icon-btn" onClick={onCancel}><X size={16} /></button>
        </div>
        <label className="field-label">English</label>
        <input className="input" value={en} onChange={(e) => setEn(e.target.value)} placeholder="e.g. house" />
        <label className="field-label">Arabic (with vowels)</label>
        <input className="input arabic-input" dir="rtl" ref={arRef} value={ar} onChange={(e) => setAr(e.target.value)} placeholder="بَيْت" />
        <ArabicKeyboard onKey={insertChar} onBackspace={() => setAr((a) => a.slice(0, -1))} />
        <label className="field-label">Notes (optional)</label>
        <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="category, gender, plural…" />
        <button className="btn btn-gold" disabled={!en.trim() || !ar.trim()} onClick={() => onSave({ id: initial?.id || uid(), en, ar, notes })}>
          Save word
        </button>
      </div>
    </div>
  );
}

function ArabicKeyboard({ onKey, onBackspace }) {
  return (
    <div className="ar-kbd">
      <div className="ar-kbd-row diacritics">
        {ARABIC_KEYS_DIACRITICS.map((d) => (
          <button key={d.ch} className="ar-key ar-key-diacritic" title={d.label} onClick={() => onKey(d.ch)}>
            ا{d.ch}
          </button>
        ))}
      </div>
      <div className="ar-kbd-row letters">
        {ARABIC_KEYS_LETTERS.map((ch) => (
          <button key={ch} className="ar-key" onClick={() => onKey(ch)}>{ch}</button>
        ))}
        <button className="ar-key ar-key-wide" onClick={onBackspace}>⌫</button>
      </div>
    </div>
  );
}

// ---------- Study Session ----------
function buildQueue(user, sharedDecks, config) {
  const list = config.source === "trouble" ? troubleWords(user, sharedDecks, config.deckIds) : dueWords(user, sharedDecks, config.deckIds);
  const size = user.settings.sessionSize || 40;
  return shuffle(list).slice(0, size);
}

function makeMCOptions(word, pool, direction) {
  const correctVal = direction === "en-ar" ? word.ar : word.en;
  const others = shuffle(pool.filter((w) => w.id !== word.id)).slice(0, 3);
  const options = shuffle([correctVal, ...others.map((w) => (direction === "en-ar" ? w.ar : w.en))]);
  return options;
}

function StudySession({ user, setUser, sharedDecks, config, onFinish }) {
  const [queue, setQueue] = useState(() => buildQueue(user, sharedDecks, config));
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState("question"); // question | feedback
  const [wasCorrect, setWasCorrect] = useState(null);
  const [typed, setTyped] = useState("");
  const [selectedMC, setSelectedMC] = useState(null);
  const [cardDirection, setCardDirection] = useState(user.settings.direction === "mixed" ? (Math.random() < 0.5 ? "en-ar" : "ar-en") : user.settings.direction);
  const [stats, setStats] = useState({ reviewed: 0, correct: 0, promoted: 0, demoted: 0, mastered: 0 });
  const inputRef = useRef(null);
  const settingsDirection = user.settings.direction;
  const answerMode = user.settings.answerMode || "mixed";
  const startedRef = useRef(false);

  useEffect(() => {
    if (!startedRef.current) {
      startedRef.current = true;
      setUser((u) => ({ ...u, sessionCount: u.sessionCount + 1 }));
    }
  }, []);

  const deckIdSet = config.deckIds ? new Set(config.deckIds) : null;
  const pool = allWords(user, sharedDecks).filter((w) => (deckIdSet ? deckIdSet.has(w.deckId) : true));
  const current = queue[idx];

  useEffect(() => {
    setTyped("");
    setSelectedMC(null);
    setPhase("question");
    setCardDirection(settingsDirection === "mixed" ? (Math.random() < 0.5 ? "en-ar" : "ar-en") : settingsDirection);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [idx]);

  if (!current) {
    return <SessionSummary stats={stats} onFinish={onFinish} />;
  }

  const direction = cardDirection;
  let showMC;
  if (answerMode === "mc") showMC = true;
  else if (answerMode === "typing") showMC = false;
  else showMC = current.box === 0; // mixed: new words start as multiple choice
  const promptText = direction === "en-ar" ? current.en : current.ar;
  const promptIsArabic = direction === "ar-en";
  const mcOptions = showMC ? makeMCOptions(current, pool, direction) : null;

  function applyResult(correct) {
    setWasCorrect(correct);
    setPhase("feedback");

    const copy = JSON.parse(JSON.stringify(user));

    // Resolve a mutable progress object regardless of where it lives.
    let w;
    if (current.source === "shared") {
      copy.sharedProgress = copy.sharedProgress || {};
      copy.sharedProgress[current.deckId] = copy.sharedProgress[current.deckId] || {};
      const existing = copy.sharedProgress[current.deckId][current.id] || freshProgress();
      copy.sharedProgress[current.deckId][current.id] = existing;
      w = existing;
    } else {
      const deck = copy.decks.find((d) => d.words.some((x) => x.id === current.id));
      w = deck.words.find((x) => x.id === current.id);
    }

    const wasBox = w.box;
    const wasMastered = w.mastered;
    let promoted = 0, demoted = 0, justMastered = 0;

    if (correct) {
      w.totalCorrect++;
      if (w.box === 0) {
        w.box = 1;
      } else if (w.box === 5) {
        if (w.lastCorrectAtMax) {
          w.mastered = true;
        } else {
          w.lastCorrectAtMax = true;
        }
      } else {
        w.box = Math.min(5, w.box + 1);
        w.lastCorrectAtMax = false;
      }
      w.dueSession = copy.sessionCount + BOX_INTERVALS[w.box];
      if (w.box > wasBox) promoted = 1;
    } else {
      w.totalWrong++;
      w.lastCorrectAtMax = false;
      if (w.box > 0) w.box = 1;
      if (w.totalWrong >= TROUBLE_THRESHOLD) w.trouble = true;
      w.dueSession = copy.sessionCount + BOX_INTERVALS[1];
      demoted = 1;
    }
    if (w.mastered && !wasMastered) justMastered = 1;

    setUser(copy);
    setStats((s) => ({
      reviewed: s.reviewed + 1,
      correct: s.correct + (correct ? 1 : 0),
      promoted: s.promoted + promoted,
      demoted: s.demoted + demoted,
      mastered: s.mastered + justMastered,
    }));
  }

  function checkTyped() {
    const target = direction === "en-ar" ? current.ar : current.en;
    let correct;
    if (direction === "en-ar") {
      if (user.settings.strictness === "exact") {
        correct = normalizeAr(typed) === normalizeAr(target);
      } else {
        correct = stripDiacritics(typed) === stripDiacritics(target);
      }
    } else {
      const acceptable = target.split(",").map(normalizeEn);
      correct = acceptable.includes(normalizeEn(typed));
    }
    applyResult(correct);
  }

  function checkMC(opt) {
    setSelectedMC(opt);
    const target = direction === "en-ar" ? current.ar : current.en;
    const correct = direction === "en-ar" ? stripDiacritics(opt) === stripDiacritics(target) : normalizeEn(opt) === normalizeEn(target);
    applyResult(correct);
  }

  function next() {
    setIdx((i) => i + 1);
  }

  const correctAnswerDisplay = direction === "en-ar" ? current.ar : current.en;

  return (
    <div className="screen study">
      <div className="progress-row">
        <div className="progress-track"><div className="progress-fill" style={{ width: `${(idx / queue.length) * 100}%` }} /></div>
        <div className="progress-text">{idx + 1} / {queue.length}</div>
        <button className="linklike" onClick={onFinish}>end session</button>
      </div>

      <div className="card flashcard">
        <div className="flash-eyebrow">{showMC ? "multiple choice" : "type the answer"} · {direction === "en-ar" ? "EN → AR" : "AR → EN"}</div>
        <div className={"flash-prompt" + (promptIsArabic ? " arabic" : "")} dir={promptIsArabic ? "rtl" : "ltr"}>
          {promptText}
        </div>
        {current.notes && <div className="flash-notes">{current.notes}</div>}

        {phase === "question" && mcOptions && (
          <div className="mc-grid">
            {mcOptions.map((opt, i) => (
              <button key={i} className="mc-btn" dir={direction === "en-ar" ? "rtl" : "ltr"} onClick={() => checkMC(opt)}>
                {opt}
              </button>
            ))}
          </div>
        )}

        {phase === "question" && !mcOptions && (
          <div className="type-area">
            <input
              ref={inputRef}
              className={"input type-input" + (direction === "en-ar" ? " arabic-input" : "")}
              dir={direction === "en-ar" ? "rtl" : "ltr"}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && typed.trim() && checkTyped()}
              placeholder={direction === "en-ar" ? "اكتب هنا" : "type in English"}
            />
            {direction === "en-ar" && (
              <ArabicKeyboard onKey={(ch) => setTyped((t) => t + ch)} onBackspace={() => setTyped((t) => t.slice(0, -1))} />
            )}
            <button className="btn btn-gold" disabled={!typed.trim()} onClick={checkTyped}>Check</button>
          </div>
        )}

        {phase === "feedback" && (
          <div className={"feedback " + (wasCorrect ? "feedback-correct" : "feedback-wrong")}>
            <div className="feedback-icon">{wasCorrect ? <Check size={22} /> : <X size={22} />}</div>
            <div>
              <div className="feedback-title">{wasCorrect ? "Correct" : "Not quite"}</div>
              <div className="feedback-answer" dir={direction === "en-ar" ? "rtl" : "ltr"}>{correctAnswerDisplay}</div>
            </div>
            <button className="btn btn-outline" onClick={next}>Next <ChevronRight size={16} /></button>
          </div>
        )}
      </div>
    </div>
  );
}

function SessionSummary({ stats, onFinish }) {
  return (
    <div className="screen">
      <div className="card summary">
        <div className="card-title">Session complete</div>
        <div className="summary-grid">
          <div><b>{stats.reviewed}</b><span>reviewed</span></div>
          <div><b>{stats.correct}</b><span>correct</span></div>
          <div><b>{stats.promoted}</b><span>moved up</span></div>
          <div><b>{stats.demoted}</b><span>moved back</span></div>
        </div>
        <button className="btn btn-gold big" onClick={onFinish}>Done</button>
      </div>
    </div>
  );
}

// ---------- Stats ----------
function StatsScreen({ user, sharedDecks, onBack }) {
  const words = allWords(user, sharedDecks);
  const total = words.length;
  const mastered = words.filter((w) => w.mastered).length;
  const trouble = words.filter((w) => w.trouble).length;
  const worst = [...words].sort((a, b) => b.totalWrong - a.totalWrong).slice(0, 8).filter(w => w.totalWrong > 0);

  return (
    <div className="screen">
      <div className="row-header">
        <button className="linklike" onClick={onBack}>← back</button>
      </div>
      <div className="card">
        <div className="card-title">Overview</div>
        <div className="summary-grid">
          <div><b>{total}</b><span>total words</span></div>
          <div><b>{mastered}</b><span>mastered</span></div>
          <div><b>{trouble}</b><span>trouble words</span></div>
          <div><b>{user.sessionCount}</b><span>sessions</span></div>
        </div>
      </div>
      <div className="card">
        <div className="card-title">Most missed words</div>
        {worst.length === 0 && <div className="empty">No mistakes logged yet — nice work.</div>}
        {worst.map((w) => (
          <div className="word-row" key={w.id}>
            <div className="word-en">{w.en}</div>
            <div className="word-ar" dir="rtl">{w.ar}</div>
            <div className="badge badge-red">{w.totalWrong} misses</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Settings ----------
function SettingsScreen({ user, setUser, onBack }) {
  function update(patch) {
    setUser((u) => ({ ...u, settings: { ...u.settings, ...patch } }));
  }

  return (
    <div className="screen">
      <div className="row-header">
        <button className="linklike" onClick={onBack}>← back</button>
      </div>

      <div className="card">
        <div className="card-title">Study direction</div>
        <div className="toggle-row toggle-row-3">
          <button className={"toggle-opt" + (user.settings.direction === "en-ar" ? " active" : "")} onClick={() => update({ direction: "en-ar" })}>
            English → Arabic
          </button>
          <button className={"toggle-opt" + (user.settings.direction === "ar-en" ? " active" : "")} onClick={() => update({ direction: "ar-en" })}>
            <ArrowLeftRight size={14} /> Arabic → English
          </button>
          <button className={"toggle-opt" + (user.settings.direction === "mixed" ? " active" : "")} onClick={() => update({ direction: "mixed" })}>
            Mixed
          </button>
        </div>
        <div className="hint">Mixed picks a random direction for each card in a session.</div>
      </div>

      <div className="card">
        <div className="card-title">Answer options</div>
        <div className="toggle-row toggle-row-3">
          <button className={"toggle-opt" + (user.settings.answerMode === "mc" ? " active" : "")} onClick={() => update({ answerMode: "mc" })}>
            Multiple choice only
          </button>
          <button className={"toggle-opt" + (user.settings.answerMode === "typing" ? " active" : "")} onClick={() => update({ answerMode: "typing" })}>
            Typing only
          </button>
          <button className={"toggle-opt" + (user.settings.answerMode === "mixed" ? " active" : "")} onClick={() => update({ answerMode: "mixed" })}>
            Mixed
          </button>
        </div>
        <div className="hint">Mixed shows new words as multiple choice, then switches to typing once a word has been answered correctly once.</div>
      </div>

      <div className="card">
        <div className="card-title">Words per session</div>
        <div className="toggle-row toggle-row-3">
          {[20, 40, 60].map((n) => (
            <button key={n} className={"toggle-opt" + (user.settings.sessionSize === n ? " active" : "")} onClick={() => update({ sessionSize: n })}>
              {n} words
            </button>
          ))}
        </div>
        <div className="hint">Caps how many due or trouble words are pulled into a single study session.</div>
      </div>

      <div className="card">
        <div className="card-title">Typing strictness</div>
        <div className="toggle-row">
          <button className={"toggle-opt" + (user.settings.strictness === "exact" ? " active" : "")} onClick={() => update({ strictness: "exact" })}>
            Exact (vowels required)
          </button>
          <button className={"toggle-opt" + (user.settings.strictness === "letters" ? " active" : "")} onClick={() => update({ strictness: "letters" })}>
            Letters only
          </button>
        </div>
        <div className="hint">"Letters only" ignores vowel marks when checking your typed Arabic answer.</div>
      </div>
    </div>
  );
}

// ---------- Styles ----------
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Amiri:ital,wght@0,400;0,700;1,400&family=Inter:wght@400;500;600;700&display=swap');

:root {
  --bg: #14212B;
  --surface: #1C2E3A;
  --surface-2: #24394A;
  --border: #33495A;
  --gold: #CBA135;
  --gold-soft: #E4C468;
  --teal: #4FA79A;
  --rust: #B4522F;
  --text: #F1E9D8;
  --text-muted: #9FB3BE;
}

* { box-sizing: border-box; }

.avapp, .gate {
  font-family: 'Inter', sans-serif;
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  width: 100%;
}

.gate {
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.gate-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 36px 28px;
  max-width: 380px;
  width: 100%;
  text-align: center;
}
.gate-mark { font-size: 32px; color: var(--gold); margin-bottom: 4px; }
.gate-title { font-family: 'Amiri', serif; font-size: 40px; color: var(--gold-soft); }
.gate-sub { color: var(--text-muted); font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 16px; }
.gate-copy { color: var(--text-muted); font-size: 14px; margin-bottom: 20px; }
.gate-input {
  width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--border);
  background: var(--surface-2); color: var(--text); font-size: 16px; margin-bottom: 14px;
}
.gate-input:focus { outline: 2px solid var(--gold); }
.gate-note { margin-top: 16px; color: var(--text-muted); font-size: 12px; line-height: 1.5; }

.avapp-body { padding: 12px 14px 90px; max-width: 640px; margin: 0 auto; }

.topbar {
  display: flex; justify-content: space-between; align-items: center;
  padding: 14px 16px; border-bottom: 1px solid var(--border); background: var(--surface);
  position: sticky; top: 0; z-index: 5;
}
.topbar-title { font-family: 'Amiri', serif; font-size: 20px; color: var(--gold-soft); display: flex; align-items: baseline; gap: 8px; }
.topbar-sub { font-family: 'Inter', sans-serif; font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; }
.topbar-user { display: flex; gap: 10px; align-items: center; font-size: 13px; color: var(--text-muted); }

.screen { display: flex; flex-direction: column; gap: 12px; padding-top: 12px; }

.card {
  background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 16px;
}
.card-title { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--gold-soft); margin-bottom: 10px; font-weight: 600; }
.card-title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.deck-header-actions { display: flex; align-items: center; gap: 14px; }

.hero { background: linear-gradient(135deg, var(--surface-2), var(--surface)); }
.hero-eyebrow { font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em; }
.hero-name { font-family: 'Amiri', serif; font-size: 28px; color: var(--text); margin: 2px 0 12px; }
.hero-stats { display: flex; gap: 20px; font-size: 13px; color: var(--text-muted); }
.hero-stats b { color: var(--gold-soft); font-size: 16px; display: block; }

.shelf { display: flex; flex-direction: column; gap: 6px; }
.shelf-row { display: grid; grid-template-columns: 56px 1fr 30px; align-items: center; gap: 8px; }
.shelf-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; }
.shelf-track { height: 16px; background: var(--surface-2); border-radius: 4px; overflow: hidden; }
.shelf-fill { height: 100%; background: linear-gradient(90deg, var(--gold), var(--gold-soft)); border-radius: 4px; transition: width 0.4s ease; }
.mastered-fill { background: linear-gradient(90deg, var(--teal), #7ecdc0); }
.shelf-count { font-size: 12px; color: var(--text-muted); text-align: right; }
.mastered-row { margin-bottom: 4px; padding-bottom: 6px; border-bottom: 1px dashed var(--border); }

.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

.btn {
  border: none; border-radius: 10px; padding: 12px 16px; font-size: 14px; font-weight: 600;
  cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px;
  transition: transform 0.1s ease, opacity 0.15s ease;
}
.btn:disabled { opacity: 0.35; cursor: not-allowed; }
.btn:not(:disabled):active { transform: scale(0.98); }
.btn-gold { background: var(--gold); color: #1B1206; }
.btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text); }
.btn-small { padding: 8px 12px; font-size: 13px; }
.btn.big { padding: 16px; font-size: 15px; }
.file-label { cursor: pointer; }

.linklike { background: none; border: none; color: var(--gold-soft); font-size: 13px; cursor: pointer; display: flex; align-items: center; gap: 2px; }
.linklike.danger { color: var(--rust); }

.empty { color: var(--text-muted); font-size: 13px; padding: 10px 0; }

.deck-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); }
.deck-row:last-child { border-bottom: none; }
.deck-name { font-weight: 600; font-size: 14px; }
.deck-meta { font-size: 12px; color: var(--text-muted); }

.deck-chip-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.deck-chip { background: var(--surface-2); border: 1px solid var(--border); color: var(--text); padding: 8px 12px; border-radius: 20px; font-size: 13px; cursor: pointer; }
.deck-chip.active { border-color: var(--gold); color: var(--gold-soft); }
.chip-count { color: var(--text-muted); font-size: 11px; }
.new-deck-row { display: flex; gap: 8px; }

.input { width: 100%; padding: 11px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font-size: 14px; margin-bottom: 10px; }
.input:focus { outline: 2px solid var(--gold); }
.arabic-input { font-family: 'Amiri', serif; font-size: 22px; }

.hint { font-size: 12px; color: var(--text-muted); margin: 6px 0 10px; }

.word-list { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.word-row { display: grid; grid-template-columns: 1fr 1fr auto auto; gap: 8px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border); }
.word-en { font-size: 13px; }
.word-ar { font-family: 'Amiri', serif; font-size: 18px; }
.word-badges { display: flex; gap: 4px; flex-wrap: wrap; }
.word-actions { display: flex; gap: 4px; }
.badge { font-size: 10px; background: var(--surface-2); color: var(--text-muted); padding: 3px 7px; border-radius: 8px; text-transform: uppercase; }
.badge-gold { background: rgba(203,161,53,0.2); color: var(--gold-soft); }
.badge-red { background: rgba(180,82,47,0.2); color: #e08a68; }
.icon-btn { background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 6px; color: var(--text-muted); cursor: pointer; }

.confirm-message { font-size: 14px; color: var(--text); margin: 4px 0 16px; line-height: 1.5; }
.confirm-modal { max-width: 360px; }

.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: flex-end; justify-content: center; z-index: 50; }
.modal { background: var(--surface); border: 1px solid var(--border); border-radius: 16px 16px 0 0; padding: 20px; width: 100%; max-width: 480px; max-height: 90vh; overflow-y: auto; }
.modal-title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.field-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; display: block; }

.ar-kbd { margin-bottom: 12px; }
.ar-kbd-row { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 5px; }
.ar-key { background: var(--surface-2); border: 1px solid var(--border); color: var(--text); border-radius: 7px; padding: 5px 7px; font-family: 'Amiri', serif; font-size: 20px; line-height: 1; cursor: pointer; min-width: 32px; }
.ar-key-diacritic { color: var(--gold-soft); font-size: 19px; }
.ar-key-wide { min-width: 50px; }

.row-header { display: flex; }

.deck-callout, .callout { border-color: var(--gold); }

.progress-row { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
.progress-track { flex: 1; height: 6px; background: var(--surface-2); border-radius: 3px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--gold); }
.progress-text { font-size: 12px; color: var(--text-muted); white-space: nowrap; }

.flashcard { text-align: center; padding: 32px 20px; }
.flash-eyebrow { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 14px; }
.flash-prompt { font-size: 26px; font-weight: 600; margin-bottom: 8px; }
.flash-prompt.arabic { font-family: 'Amiri', serif; font-size: 44px; }
.flash-notes { color: var(--text-muted); font-size: 13px; margin-bottom: 16px; }

.mc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 18px; }
.mc-btn { background: var(--surface-2); border: 1px solid var(--border); color: var(--text); border-radius: 10px; padding: 16px 10px; font-size: 18px; font-family: 'Amiri', serif; cursor: pointer; }
.mc-btn:hover { border-color: var(--gold); }

.type-area { margin-top: 18px; }
.type-input { text-align: center; font-size: 20px; }

.feedback { margin-top: 20px; display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 16px; border-radius: 12px; }
.feedback-correct { background: rgba(79,167,154,0.14); }
.feedback-wrong { background: rgba(180,82,47,0.14); }
.feedback-icon { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
.feedback-correct .feedback-icon { background: var(--teal); color: #06231f; }
.feedback-wrong .feedback-icon { background: var(--rust); color: #2a0f06; }
.feedback-title { font-weight: 600; font-size: 15px; }
.feedback-answer { font-family: 'Amiri', serif; font-size: 24px; color: var(--gold-soft); margin-top: 2px; }

.summary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
.summary-grid > div { background: var(--surface-2); border-radius: 10px; padding: 14px; text-align: center; }
.summary-grid b { display: block; font-size: 22px; color: var(--gold-soft); }
.summary-grid span { font-size: 11px; color: var(--text-muted); text-transform: uppercase; }

.toggle-row { display: flex; gap: 8px; margin-bottom: 6px; }
.toggle-row-3 { flex-wrap: wrap; }
.toggle-row-3 .toggle-opt { flex: 1 1 30%; min-width: 100px; }
.toggle-opt { flex: 1; background: var(--surface-2); border: 1px solid var(--border); color: var(--text-muted); border-radius: 10px; padding: 10px; font-size: 13px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; }
.toggle-opt.active { border-color: var(--gold); color: var(--gold-soft); }

.multi-deck-list { display: flex; flex-direction: column; gap: 4px; margin: 10px 0; }
.multi-deck-row { display: flex; align-items: center; gap: 10px; padding: 8px 4px; border-bottom: 1px solid var(--border); font-size: 13px; cursor: pointer; }
.multi-deck-row:last-child { border-bottom: none; }
.multi-deck-row input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--gold); }
.multi-deck-row span:first-of-type { flex: 1; }

.bottomnav {
  position: fixed; bottom: 0; left: 0; right: 0; background: var(--surface); border-top: 1px solid var(--border);
  display: flex; z-index: 10;
}
.nav-btn { flex: 1; background: none; border: none; color: var(--text-muted); padding: 10px 0 8px; display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: 10px; cursor: pointer; }
.nav-btn.active { color: var(--gold-soft); }

@media (max-width: 420px) {
  .flash-prompt.arabic { font-size: 34px; }
  .mc-grid { grid-template-columns: 1fr; }
}
`;
