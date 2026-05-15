// Vercel Cron Job - 5분마다 자동 실행
// Binance REST API로 최근 거래량 조회 → Neon DB 저장

import { neon } from '@neondatabase/serverless';

export const config = {
  maxDuration: 30,
};

export default async function handler(req, res) {
  // Vercel Cron 인증 확인
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sql = neon(process.env.DATABASE_URL);

  // 테이블 자동 생성
  await sql`
    CREATE TABLE IF NOT EXISTS pressure_history (
      id         SERIAL PRIMARY KEY,
      ts         BIGINT NOT NULL,
      symbol     VARCHAR(20) DEFAULT 'BTCUSDT',
      buy_vol    NUMERIC,
      sell_vol   NUMERIC,
      buy_pct    NUMERIC,
      weighted   NUMERIC,
      ls         INTEGER DEFAULT 0,
      ss         INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
  const results = [];

  for (const symbol of symbols) {
    try {
      // Binance: 최근 5분간 거래 데이터 (1분봉 5개)
      const r = await fetch(
        `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=5`
      );
      const klines = await r.json();

      if (!Array.isArray(klines) || klines.length === 0) continue;

      // taker_buy_base_asset_volume (인덱스 9) = 매수 거래량
      // volume (인덱스 5) = 전체 거래량
      let totalBuy = 0, totalVol = 0;
      for (const k of klines) {
        totalVol += parseFloat(k[5]);
        totalBuy += parseFloat(k[9]);
      }
      const totalSell = totalVol - totalBuy;
      const buyPct = totalVol > 0 ? (totalBuy / totalVol) * 100 : 50;
      const diff = buyPct - 50;

      // 점수 계산
      let ls = 0, ss = 0;
      const abs = Math.abs(diff);
      if (diff > 0) {
        if (abs >= 20) ls = 20;
        else if (abs >= 15) ls = 16;
        else if (abs >= 10) ls = 12;
        else if (abs >= 5)  ls = 7;
        else if (abs >= 2)  ls = 3;
      } else if (diff < 0) {
        if (abs >= 20) ss = 20;
        else if (abs >= 15) ss = 16;
        else if (abs >= 10) ss = 12;
        else if (abs >= 5)  ss = 7;
        else if (abs >= 2)  ss = 3;
      }

      // DB 저장
      await sql`
        INSERT INTO pressure_history (ts, symbol, buy_vol, sell_vol, buy_pct, weighted, ls, ss)
        VALUES (
          ${Date.now()},
          ${symbol},
          ${totalBuy.toFixed(4)},
          ${totalSell.toFixed(4)},
          ${buyPct.toFixed(2)},
          ${buyPct.toFixed(2)},
          ${ls},
          ${ss}
        )
      `;

      results.push({ symbol, buyPct: buyPct.toFixed(2), ls, ss });
    } catch (e) {
      console.error(`Error for ${symbol}:`, e.message);
    }
  }

  // 오래된 데이터 정리 (288개 초과분 = 24시간 넘은 것)
  await sql`
    DELETE FROM pressure_history
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY ts DESC) as rn
        FROM pressure_history
      ) ranked
      WHERE rn > 288
    )
  `;

  return res.status(200).json({ ok: true, ts: new Date().toISOString(), results });
}
