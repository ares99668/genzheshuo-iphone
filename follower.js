// The short-clause parser and rolling alignment follow the desktop Follower rules.
const soft = "，,：:";
const hard = "。！？!?；;.…";
const closing = "”’」』》】";
const separators = soft + hard;
const digitNames = "零一二三四五六七八九";
const fillers = "啊呀呢嗯呃哦";
const transitions = ["然后", "但是", "因为", "所以", "如果", "大家", "今天", "现在", "咱们", "我们", "接下来", "另外"];
const genericWords = new Set(["这个", "那个", "就是", "一个", "然后", "可以", "我们", "你们"]);

function integerChinese(n) {
  if (n === 0) return "零";
  for (const [power, unit, zeroLimit] of [[1e8, "亿", 1e7], [1e4, "万", 1000]]) {
    if (n >= power) {
      const remainder = n % power;
      return integerChinese(Math.floor(n / power)) + unit +
        (remainder ? (remainder < zeroLimit ? "零" : "") + integerChinese(remainder) : "");
    }
  }
  let result = "";
  let addZero = false;
  for (const [power, unit] of [[1000, "千"], [100, "百"], [10, "十"], [1, ""]]) {
    const digit = Math.floor(n / power);
    n %= power;
    if (digit) {
      if (addZero) result += "零";
      if (!(digit === 1 && unit === "十" && !result)) result += digitNames[digit];
      result += unit;
      addZero = false;
    } else if (result && n) addZero = true;
  }
  return result;
}

function numberChinese(value, byDigit) {
  const digits = (text) => Array.from(text, c => c === "." ? "点" : digitNames[Number(c)]).join("");
  if (byDigit) return digits(value);
  const [whole, fractional] = value.split(".");
  if (fractional !== undefined) return numberChinese(whole, false) + "点" + digits(fractional);
  if (whole.length > 9 || (whole.length > 1 && whole[0] === "0")) return digits(whole);
  return integerChinese(Number(whole));
}

export function normalize(text, byDigit = false) {
  const stack = [];
  const ignored = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    if ("（(".includes(text[i])) stack.push(i);
    else if ("）)".includes(text[i]) && stack.length) ignored.fill(1, stack.pop(), i + 1);
  }
  let speech = "";
  const offsets = [];
  for (const match of text.matchAll(/[0-9０-９]+(?:[.．][0-9０-９]+)?|./gsu)) {
    if (ignored[match.index]) continue;
    let token = match[0].normalize("NFKC").toLowerCase();
    if (/^\d+(?:\.\d+)?$/.test(token)) token = numberChinese(token, byDigit);
    token = token.replaceAll("两", "二").replaceAll("〇", "零");
    for (const c of token) {
      if (!/[\p{L}\p{N}]/u.test(c)) continue;
      speech += c;
      for (let k = 0; k < c.length; k++) offsets.push(match.index + match[0].length);
    }
  }
  return { speech, offsets };
}

function* naturalClauses(line) {
  let start = 0;
  let depth = 0;
  for (let pos = 0; pos < line.length;) {
    const char = line[pos++];
    if ("（(".includes(char)) depth++;
    else if ("）)".includes(char)) depth = Math.max(0, depth - 1);
    if (depth || !separators.includes(char)) continue;
    if (pos > 1 && pos < line.length) {
      const left = line[pos - 2];
      const right = line[pos];
      if (",，:：.".includes(char) && /\p{Nd}/u.test(left) && /\p{Nd}/u.test(right)) continue;
      if (char === "." && /[A-Za-z0-9]/.test(left) && /[A-Za-z0-9]/.test(right)) continue;
    }
    let end = hard.includes(char);
    while (pos < line.length && (separators + closing).includes(line[pos])) {
      end ||= hard.includes(line[pos]);
      pos++;
    }
    yield { clause: line.slice(start, pos), end };
    start = pos;
  }
  if (start < line.length) yield { clause: line.slice(start), end: true };
}

function shorten(clause) {
  const pieces = [];
  for (;;) {
    const { offsets } = normalize(clause);
    if (offsets.length <= 27) break;
    const protectedOffsets = new Set();
    for (const match of clause.matchAll(/[A-Za-zＡ-Ｚａ-ｚ0-9０-９]+(?:[.．,:：，/％%_-][A-Za-zＡ-Ｚａ-ｚ0-9０-９]+)*/g)) {
      for (let i = match.index + 1; i < match.index + match[0].length; i++) protectedOffsets.add(i);
    }
    let cut;
    let score = -Infinity;
    for (let n = 13; n <= Math.min(25, offsets.length - 8); n++) {
      const after = offsets[n - 1];
      if (protectedOffsets.has(after) || after === offsets[n]) continue;
      const natural = /\s/.test(clause[after]) || transitions.some(word => clause.startsWith(word, after));
      const rank = (natural ? 50 : 0) - Math.abs(n - 20);
      if (rank > score) { score = rank; cut = after; }
    }
    cut ??= offsets.slice(19).find(i => !protectedOffsets.has(i) && i < offsets.at(-1));
    if (cut === undefined) break;
    while (cut < clause.length && ("、 " + closing).includes(clause[cut])) cut++;
    pieces.push(clause.slice(0, cut));
    clause = clause.slice(cut);
  }
  if (clause) pieces.push(clause);
  return pieces;
}

export function parseScript(raw) {
  const sentences = [];
  for (const rawLine of raw.replace(/^\uFEFF+/, "").split(/\r\n|[\r\n\v\f\x1c-\x1e\x85\u2028\u2029]/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let pending = "";
    let group = [];
    for (const {clause, end} of naturalClauses(line)) {
      pending += clause;
      if (normalize(pending).speech.length >= 4) {
        group.push(...shorten(pending));
        pending = "";
      }
      if (end) {
        if (pending) {
          if (group.length) group[group.length - 1] += pending;
          else group.push(pending);
          pending = "";
        }
        sentences.push(...group);
        group = [];
      }
    }
    if (pending) {
      if (group.length) group[group.length - 1] += pending;
      else group.push(pending);
    }
    sentences.push(...group);
  }
  return sentences;
}

export class Follower {
  constructor(cues, phonetics) {
    this.phonetics = phonetics;
    this.normalized = cues.map(cue => normalize(cue));
    this.variants = cues.map((cue, index) => {
      const primary = this.normalized[index];
      const alternate = normalize(cue, true);
      return primary.speech === alternate.speech ? [primary] : [primary, alternate];
    });
    this.reset(0);
  }

  reset(index) {
    this.index = Math.max(0, Math.min(index, this.normalized.length - 1));
    this.preview = this.index;
    this.character = 0;
    this.anchor = "";
    this.segment = -1;
    this.confirmedSegment = -1;
    this.confirmedLength = 0;
    this.previous = null;
    this.previousFinal = false;
    this.pending = null;
  }

  result() {
    return { index: this.index, preview: this.preview, character: this.character };
  }

  sound(char) {
    return this.phonetics[char] ?? char;
  }

  align(heard, target, index) {
    if (!heard || !target) return null;
    const n = heard.length;
    const m = target.length;
    const hearing = Array.from({length:n}, (_, i) => this.sound(heard[i]));
    const writing = Array.from({length:m}, (_, i) => this.sound(target[i]));
    const rows = Array.from({length:n + 1}, () => new Float64Array(m + 1));
    const moves = Array.from({length:n + 1}, () => new Uint8Array(m + 1));
    for (let i = 1; i <= n; i++) {
      const char = heard[i - 1];
      const penalty = fillers.includes(char) ? 0.65 : 1.1;
      for (let j = 1; j <= m; j++) {
        const reward = char === target[j - 1] ? 2 : hearing[i - 1] === writing[j - 1] ? 1.45 : -1.25;
        const diagonal = rows[i - 1][j - 1] + reward;
        const insertion = rows[i - 1][j] - penalty;
        const deletion = rows[i][j - 1] - 0.9;
        const value = Math.max(0, diagonal, insertion, deletion);
        rows[i][j] = value;
        if (value > 0) moves[i][j] = value === diagonal ? 1 : value === insertion ? 2 : 3;
      }
    }
    const ends = [];
    for (let j = 1; j <= m; j++) {
      ends.push({score:rows[n][j], i:n, j});
      if (n > 1 && fillers.includes(heard.at(-1))) ends.push({score:rows[n - 1][j] - 0.5, i:n - 1, j});
    }
    ends.sort((a,b) => b.score - a.score || a.j - b.j);
    for (const endpoint of ends.slice(0,4)) {
      let {i, j, score} = endpoint;
      if (score <= 0) continue;
      let exact = 0, phonetic = 0, edits = 0, end = 0, start = 0, heardEnd = 0, heardStart = 0;
      while (i > 0 && j > 0 && moves[i][j]) {
        const move = moves[i][j];
        if (move === 1) {
          if (hearing[i - 1] === writing[j - 1]) {
            if (heard[i - 1] === target[j - 1]) exact++;
            else phonetic++;
            if (!end) { end = j; heardEnd = i; }
            start = j - 1;
            heardStart = i - 1;
          } else edits++;
          i--; j--;
        } else if (move === 2) {
          edits++; i--;
        } else {
          edits++; j--;
        }
      }
      const lag = n - heardEnd;
      if (!end || lag > 3) continue;
      return { index, end, start, score, exact, support:exact + phonetic, heardStart, heardEnd,
        confidence:(exact + phonetic * .8) / (exact + phonetic + edits), lag, originalEnd:0, phrase:false };
    }
    return null;
  }

  phraseEvidence(heard, target, match) {
    if (match.exact < 4 || match.confidence < .46 || match.heardEnd !== heard.length) return false;
    const local = heard.slice(-target.length - 5);
    const positions = new Set();
    for (let i = 0; i < target.length - 1; i++) {
      if (local.includes(target.slice(i,i + 2))) { positions.add(i); positions.add(i + 1); }
    }
    if (positions.size < 4 || new Set(Array.from(positions, i => target[i])).size < 4) return false;
    const end = match.end;
    if (end < 2 || this.sound(local.at(-1)) !== this.sound(target[end - 1])) return false;
    if (positions.has(end - 1) && local.slice(-4).includes(target.slice(end - 2,end))) return true;
    if ("的吗吧啊啦呀了得么嘛呢也是就我你他们个着过一".includes(target[end - 1])) return false;
    for (let i = Math.max(0, end - 5); i < end - 1; i++) {
      if (positions.has(i) && local.slice(-6).includes(target.slice(i,i + 2))) return true;
    }
    return false;
  }

  nextSpoken() {
    for (let i = this.index + 1; i < this.normalized.length; i++) {
      if (this.normalized[i].speech) return i;
    }
    return this.index;
  }

  tailMatch(heard, segment) {
    if (this.preview !== this.index || segment !== this.confirmedSegment ||
        !this.anchor || !heard.startsWith(this.anchor)) return null;
    const fresh = heard.slice(this.anchor.length);
    for (const {speech, offsets} of this.variants[this.index]) {
      const position = offsets.filter(offset => offset <= this.character).length;
      const tail = speech.slice(position);
      const ending = tail.slice(-2);
      if (position >= Math.max(3, Math.floor(speech.length / 3)) &&
          tail.length >= 4 && tail.length <= 14 && fresh.length >= 4 &&
          fresh.length <= Math.min(22, 2 * tail.length + 2) && fresh.endsWith(ending)) {
        const beforeEnding = fresh.slice(0,-2);
        for (let i = 0; i < tail.length - 3; i++) {
          const word = tail.slice(i,i + 2);
          const start = beforeEnding.lastIndexOf(word);
          if (start < Math.max(0, beforeEnding.length - 8) || genericWords.has(word) ||
              new Set(word + ending).size < 4) continue;
          const gaps = Math.max(fresh.length - start,tail.length - i) - 4;
          return { index:this.index, end:speech.length, start:position + i, score:8 - gaps,
            confidence:4 / (4 + gaps), exact:4, support:4, heardStart:start, heardEnd:fresh.length,
            originalEnd:offsets.at(-1), lag:0, phrase:true };
        }
      }
      if (position < 3 || tail.length < 1 || tail.length > 5 ||
          fresh.length < tail.length || fresh.length > tail.length + 1) continue;
      const observed = fresh.slice(0,tail.length);
      if (!Array.from(tail).every((written,i) => this.sound(observed[i]) === this.sound(written) ||
          ("啊呀哇啦".includes(observed[i]) && "啊呀哇啦".includes(written)))) continue;
      const recent = this.anchor.slice(-position) + observed.slice(0,-1) + tail.at(-1);
      const match = this.align(recent,speech,this.index);
      if (match && match.end === speech.length && match.support >= 3) {
        return {...match, originalEnd:offsets.at(-1), lag:fresh.length - tail.length};
      }
    }
    return null;
  }

  nextPrefix(heard, segment) {
    const {speech, offsets} = this.normalized[this.index];
    const near = Math.max(0, speech.length - Math.max(4, Math.floor(speech.length / 3)));
    if (!speech || this.character < offsets[near]) return null;
    const next = this.nextSpoken();
    if (next === this.index) return null;
    const same = segment === this.confirmedSegment;
    if (same && (!this.anchor || !heard.startsWith(this.anchor))) return null;
    const fresh = same ? heard.slice(this.anchor.length) : heard;
    if (fresh.length < 2 || fresh.length > 18) return null;
    const rivalSpeech = same ? speech.split("").filter((_,i) => offsets[i] > this.character).join("") : speech;
    const rival = this.align(fresh,rivalSpeech,this.index);
    let best = null;
    for (const target of this.variants[next]) {
      const match = this.align(fresh,target.speech,next);
      if (!match) continue;
      const required = Math.min(4,target.speech.length);
      const phrase = this.phraseEvidence(fresh,target.speech,match);
      if ((match.start > (same ? 1 : 4) && !phrase) || match.support < required ||
          match.exact < Math.min(3,required) || (match.confidence < .73 && !phrase) ||
          match.heardEnd !== fresh.length || match.heardStart > 5 ||
          (rival && rival.score >= match.score - 1.4)) continue;
      if (!best || match.score > best.score) {
        best = {...match, phrase, originalEnd:target.offsets[match.end - 1]};
      }
    }
    return best;
  }

  accept(best, heard, segment, final) {
    const changed = best.index !== this.index;
    const previous = changed ? 0 : this.character;
    const fresh = !changed && segment === this.confirmedSegment && this.anchor &&
      heard.length > this.anchor.length && heard.startsWith(this.anchor) && best.originalEnd > previous;
    if (changed) {
      this.index = best.index;
      this.preview = this.index;
    }
    this.character = Math.max(previous,best.originalEnd);
    if (changed || best.originalEnd > previous) {
      this.anchor = heard.slice(0,Math.max(0,heard.length - best.lag));
      this.confirmedSegment = segment;
      this.confirmedLength = heard.length;
    }
    this.pending = null;
    const {speech, offsets} = this.normalized[this.index];
    if (!speech) return this.result();
    const remaining = offsets.filter(i => i > best.originalEnd).length;
    const next = this.nextSpoken();
    const exactTail = remaining === 0;
    const clippedTail = final && remaining <= Math.min(2,Math.floor(speech.length / 4)) && best.support >= 5;
    let almostTail = false;
    if (!final && fresh && remaining >= 1 && remaining <= Math.min(2,Math.floor((speech.length - 3) / 3)) &&
        best.lag === 0 && best.support >= 3 + remaining && best.exact >= 3 &&
        (best.confidence >= .72 || best.phrase)) {
      const spoken = speech.slice(0,-remaining);
      const ending = speech.slice(-remaining);
      const unique = spoken.length >= 3 && !spoken.slice(0,-3).includes(spoken.slice(-3));
      almostTail = unique && !/[零一二三四五六七八九十百千万亿不没无别勿]/.test(ending) &&
        !this.normalized[next].speech.startsWith(spoken);
    }
    const established = previous >= offsets[Math.floor(speech.length / 3)] && best.support >= 3;
    const enough = best.support >= Math.max(3,Math.min(6,Math.floor((speech.length + 1) / 2)));
    if ((exactTail || clippedTail || almostTail) && (established || enough) &&
        (best.confidence >= .62 || best.phrase) && best.exact >= 2 && best.lag <= 1) this.preview = next;
    return this.result();
  }

  feed(text, segment, final) {
    const {speech:heard} = normalize(text);
    if (!this.variants.length || segment < this.segment) return this.result();
    if (segment !== this.segment) {
      this.segment = segment;
      this.previous = null;
      this.previousFinal = false;
      this.pending = null;
    }
    if (heard === this.previous && (!final || this.previousFinal)) return this.result();
    this.previous = heard;
    this.previousFinal = final;
    if (heard.length < 2) return this.result();
    const early = this.tailMatch(heard,segment) ?? this.nextPrefix(heard,segment);
    if (early) return this.accept(early,heard,segment,final);

    const primary = heard.slice(-72);
    const alternate = normalize(text,true).speech.slice(-72);
    const hearing = primary === alternate ? [primary] : [primary,alternate];
    const candidates = [];
    const offsets = this.normalized[this.index].offsets;
    const discountEarlier = offsets.length && this.character >= offsets.at(-1) * .8 &&
      (segment !== this.confirmedSegment || heard.length >= this.confirmedLength + 3);
    for (let index = Math.max(0,this.index - 1); index < Math.min(this.index + 5,this.variants.length); index++) {
      for (const target of this.variants[index]) {
        for (const sample of hearing) {
          const match = this.align(sample,target.speech,index);
          if (!match || match.support < 3) continue;
          match.phrase = (index === this.index || index === this.preview) &&
            this.phraseEvidence(sample,target.speech,match);
          if (match.confidence < .57 && !match.phrase) continue;
          match.originalEnd = target.offsets[match.end - 1];
          match.rank = match.score - Math.max(0,index - this.index) * 1.7 - (discountEarlier && index < this.index ? 6 : 0);
          candidates.push(match);
        }
      }
    }
    candidates.sort((a,b) => b.rank - a.rank || Math.abs(a.index - this.index) - Math.abs(b.index - this.index));
    const best = candidates[0];
    if (!best || best.index < this.index) { this.pending = null; return this.result(); }
    if (best.index > this.index) {
      const distance = best.index - this.index;
      const length = this.normalized[best.index].speech.length;
      const minimum = distance === 1 ? Math.min(length,6) : 5 + distance;
      const rival = candidates.find(c => c.index <= this.index);
      if (best.support < minimum || best.exact < 3 || (rival && best.rank - rival.rank < 2.2) ||
          (best.confidence < (distance > 1 ? .64 : .59) && !best.phrase)) return this.result();
      const pending = this.pending;
      const growing = pending?.index === best.index && pending.heard !== heard &&
        best.originalEnd >= pending.end + (distance === 1 ? 1 : 2);
      const completed = distance === 1 && this.character > 0 && best.end === length && best.lag === 0 &&
        best.support >= Math.min(5,length) && (best.confidence >= .8 || best.phrase);
      if (!final && !growing && !completed) {
        if (pending?.index !== best.index || best.originalEnd < pending.end)
          this.pending = {index:best.index,end:best.originalEnd,heard};
        return this.result();
      }
    }
    return this.accept(best,heard,segment,final);
  }
}
