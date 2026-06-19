// 自前 2D Simplex ノイズ + fBm（フラクタル合成）。npm 依存なし。
(function (Game) {
  "use strict";

  const F2 = 0.5 * (Math.sqrt(3) - 1);
  const G2 = (3 - Math.sqrt(3)) / 6;

  // 12方向の勾配ベクトル（2D では先頭8つを使う）。
  const GRAD = [
    [1, 1], [-1, 1], [1, -1], [-1, -1],
    [1, 0], [-1, 0], [0, 1], [0, -1],
  ];

  function Noise(seed) {
    // シードからシャッフルした置換表を作る。
    const rng = Game.utils.mulberry32(seed >>> 0);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    // 512 に拡張してインデックスのラップを省略。
    this.perm = new Uint8Array(512);
    this.permMod8 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod8[i] = this.perm[i] % 8;
    }
  }

  // 2D Simplex ノイズ。戻り値はおおよそ -1..1。
  Noise.prototype.simplex2D = function (xin, yin) {
    const perm = this.perm;
    const permMod8 = this.permMod8;

    // 入力空間を simplex グリッドにスキュー。
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);

    // どちらの三角形にいるか。
    let i1, j1;
    if (x0 > y0) {
      i1 = 1; j1 = 0;
    } else {
      i1 = 0; j1 = 1;
    }

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;

    const ii = i & 255;
    const jj = j & 255;

    let n0 = 0, n1 = 0, n2 = 0;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = GRAD[permMod8[ii + perm[jj]]];
      t0 *= t0;
      n0 = t0 * t0 * (g[0] * x0 + g[1] * y0);
    }

    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = GRAD[permMod8[ii + i1 + perm[jj + j1]]];
      t1 *= t1;
      n1 = t1 * t1 * (g[0] * x1 + g[1] * y1);
    }

    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = GRAD[permMod8[ii + 1 + perm[jj + 1]]];
      t2 *= t2;
      n2 = t2 * t2 * (g[0] * x2 + g[1] * y2);
    }

    // 70 倍でおおむね [-1,1] に収まる（標準的な係数）。
    return 70 * (n0 + n1 + n2);
  };

  // フラクタルブラウン運動。複数オクターブを合成して 0..1 に正規化。
  // opts: { octaves, frequency, lacunarity, gain }
  Noise.prototype.fbm = function (x, y, opts) {
    const octaves = opts.octaves || 4;
    const lacunarity = opts.lacunarity || 2.0;
    const gain = opts.gain || 0.5;
    let freq = opts.frequency || 1.0;
    let amp = 1.0;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.simplex2D(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    // -1..1 → 0..1
    return (sum / norm) * 0.5 + 0.5;
  };

  Game.Noise = Noise;
})(window.Game);
