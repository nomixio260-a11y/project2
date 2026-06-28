// 重要イベントのトースト通知。年代記に追加された主要な出来事（滅亡・記念碑・
// 災害・継承・反乱・海外植民・疫病）を画面上部に短時間ポップアップで知らせる。
(function (Game) {
  "use strict";

  const POLL_MS = 300;
  const LIFE_MS = 3600;
  const MAX_VISIBLE = 3;
  const COOLDOWN_MS = 2600; // トースト間の最低間隔（画面が埋まらないよう間引く）
  // 通知するのは「滅亡・大噴火・地震・大記念碑・海外植民・疫病発生」など、まれで劇的な
  //   出来事のみ。継承・発明・黄金/暗黒時代・反乱・戦争などは年代記にのみ残し通知しない
  //   （何かあるたび出ていた大量のポップアップを抑える）。
  const IMPORTANT = /☠|🌋|🌐|🏛|海の彼方|疫病が発生/;

  const Toasts = { el: null, _acc: 0, _lastSeq: 0, _cool: 0 };

  Toasts.init = function () {
    const el = document.getElementById("toasts");
    if (!el) return;
    this.el = el;
    // 既存ログを通知済み扱いにする（起動直後に大量に出さない）。
    const civ = Game.state.civ;
    if (civ && civ._evSeq) this._lastSeq = civ._evSeq;
  };

  Toasts.tick = function (dt) {
    if (!this.el) return;
    if (this._cool > 0) this._cool -= dt;
    this._acc += dt;
    if (this._acc < POLL_MS) return;
    this._acc = 0;
    const civ = Game.state.civ;
    if (!civ || !civ.events) return;
    const ev = civ.events;
    // 1回のポーリングで最大1件まで、かつクールダウン中は出さない（連続イベントを間引く）。
    if (this._cool <= 0) {
      for (let i = 0; i < ev.length; i++) {
        const e = ev[i];
        if (!e.seq || e.seq <= this._lastSeq) continue;
        if (IMPORTANT.test(e.text)) { this._show(e.text); this._cool = COOLDOWN_MS; break; }
      }
    }
    // 末尾(最新)の seq まで既読に（未表示の重要イベントは溜め込まず、後でまとめて噴出させない）。
    if (ev.length) this._lastSeq = Math.max(this._lastSeq, ev[ev.length - 1].seq || 0);
  };

  Toasts._show = function (text) {
    const el = this.el;
    while (el.children.length >= MAX_VISIBLE) el.removeChild(el.firstChild);
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = text;
    t.addEventListener("click", function () { if (t.parentNode) el.removeChild(t); });
    el.appendChild(t);
    // フェードイン。
    requestAnimationFrame(function () { t.classList.add("show"); });
    setTimeout(function () {
      t.classList.remove("show");
      setTimeout(function () { if (t.parentNode) el.removeChild(t); }, 300);
    }, LIFE_MS);
  };

  // 外部から任意のメッセージを通知する（保存/読込など UI からの明示通知）。
  Toasts.show = function (text) { if (this.el) this._show(text); };

  Game.toasts = Toasts;
})(window.Game);
