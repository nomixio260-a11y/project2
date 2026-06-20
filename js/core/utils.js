// 汎用ユーティリティ。
(function (Game) {
  "use strict";

  Game.utils = {
    clamp: function (v, lo, hi) {
      return v < lo ? lo : v > hi ? hi : v;
    },

    lerp: function (a, b, t) {
      return a + (b - a) * t;
    },

    // [inMin,inMax] を [outMin,outMax] に線形写像。
    mapRange: function (v, inMin, inMax, outMin, outMax) {
      if (inMax === inMin) return outMin;
      return outMin + ((v - inMin) / (inMax - inMin)) * (outMax - outMin);
    },

    smoothstep: function (edge0, edge1, x) {
      const t = Game.utils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
      return t * t * (3 - 2 * t);
    },

    // mulberry32: 軽量で再現性のあるシード付き PRNG。
    // 32bit シードを受け取り、毎回 0..1 を返す関数を生成する。
    mulberry32: function (seed) {
      let a = seed >>> 0;
      return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    },
  };
})(window.Game);
