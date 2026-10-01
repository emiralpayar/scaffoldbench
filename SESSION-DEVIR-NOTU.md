# Agent Arena — Session Devir Notu

> Bu dosya projenin Türkçe devir notudur ve kasıtlı olarak repo'nun İngilizce
> kuralının dışındadır. Teknik dokümantasyon için `README.md`,
> `docs/ARCHITECTURE.md` ve `docs/ADDING-A-TASK.md` — hepsi İngilizce.

Tarih: 2026-07-25 · Makine: MacBook Air → Mac Mini'ye aktarıldı
Son commit: `7263bc0` · 15 commit · 374 dosya

---

## 1. Proje nedir

Aynı görev setini **beş farklı ajan harness mimarisinde** koşturup skor, maliyet
ve gecikmeyi bootstrap güven aralıklarıyla ölçen bir benchmark laboratuvarı.

Çıkış noktası: herkes "plan yapsın mı yoksa direkt mi davransın", "verifier
kendini amorti eder mi", "paralel subagent'a bölmek koordinasyon riskine değer
mi" diye tartışıyor — ve neredeyse hiç kimse sayı yayınlamıyor. Bu proje o sayıyı
üretiyor.

**Neden ölçüm güvenilir** (hepsi kodda zorlanıyor, prosada değil):

- Sandbox görevleri **LLM olmadan** puanlanıyor — son dünya durumu üzerinde
  ağırlıklı assertion'lar, artı tool journal'ından okunan ihlal cezaları.
- `PreToolUse` guard'ı built-in tool'ları engelliyor ve her kaçış denemesini
  `tool_denied` olayı olarak kaydediyor.
- Her çağrı `settingSources: []` ve pinlenmiş `tools` ile koşuyor, yani sonuç
  kimin makinesinde üretildiğine bağlı değil.
- Araştronma yarısı record/replay fixture'larıyla çalışıyor: CI'da bedava,
  offline, tekrarlanabilir.
- Her ortalama güven aralığı taşıyor; iki aralık çakışıyorsa sistem kazanan ilan
  etmek yerine **"inconclusive"** diyor.
- Judge maliyeti strateji maliyetinden ayrı tutuluyor.

---

## 2. Nerede bitti

| Bileşen | Durum |
|---|---|
| `packages/core` — sözleşmeler, runQuery, bütçe, trace, guard, judge, skorlama, istatistik, runner | ✅ |
| `packages/strategies` — 5 mimari | ✅ |
| `packages/tasks` — 3 sandbox dünyası × 3 görev + 3 araştırma görevi | ✅ |
| `apps/cli` — `arena run / report / tasks / strategies` | ✅ |
| `apps/web` — leaderboard, pareto, matrix, görev detayı, trace viewer, canlı demo | ✅ |
| CI (`ci.yml`, `bench.yml`), README, ARCHITECTURE, ADDING-A-TASK, LICENSE | ✅ |
| **437 test** · typecheck temiz · web 199 statik sayfa derliyor | ✅ |

**Beş mimari:** `single` · `plan-execute` · `orchestrator-workers` (harness'in
sahip olduğu gerçek paralel fan-out) · `plan-execute-verify` (max 2 revizyon) ·
`debate-select` (3 salt-okunur öneri → seçici → uygulayıcı).

**On iki görev:** airline / ecommerce / support × (easy, medium, hard) +
3 araştırma görevi (HTTP 301-vs-308, async-vs-defer, OWASP-vs-NIST parola
hashleme).

---

## 3. Gerçek benchmark sonucu — ve dürüst okuması

Run set `2026-07-25T20-18-35Z-3fs5` · 90 koşu · Sonnet 5 · $9.11 · 23 dakika ·
sıfır harness hatası · sıfır guard ihlali.

| Strateji | n | Skor (%95 CI) | Pass | Maliyet | Gecikme | Skor/$ |
|---|---|---|---|---|---|---|
| debate-select | 18 | 1.000 [1.000, 1.000] | 100% | $0.187 | 1m10s | 5.3 |
| single | 18 | 0.990 [0.970, 1.000] | 94% | $0.050 | 22s | **19.7** |
| plan-execute | 18 | 0.990 [0.970, 1.000] | 94% | $0.070 | 33s | 14.1 |
| plan-execute-verify | 18 | 0.990 [0.970, 1.000] | 94% | $0.109 | 52s | 9.1 |
| orchestrator-workers | 18 | 0.980 [0.950, 1.000] | 89% | $0.089 | 44s | 11.0 |

**On karşılaştırmanın onu da "inconclusive" — ve bu doğru cevap.**

Görev seti tavana vurdu: 9 görevin 8'i, 5 mimarinin hepsinde tam puan. Tek
ayrışma `ecommerce-hard`'da (iade edilen ürünler stoğa geri konmalı mı), ama
hangi mimarinin kaçırdığı **tekrarlar arasında değişiyor** — `single` r1'de
yapıyor, r2'de yapamıyor; `plan-execute` tam tersi. Yani mimari farkı değil,
gürültü.

**Dürüst okuma:** bu görev setinde ve bu modelde ekstra mimari katmanların
hiçbiri kendini geri ödemiyor; `single` aynı işi `debate-select`'in beşte birine
yapıyor. Bu bir bulgu — ama aynı zamanda görev setinin sınırı, mimarilerin
hükmü değil. Çözüm daha zor görevler, sıralama değil.

> Repo'da **uydurma hiçbir sayı yok.** `results/demo-synthetic` (180 koşu)
> arayüz geliştirmek için sentetiktir ve her sayfada "fabricated, do not quote"
> bandı çıkar; manifest'inde `synthetic: true` var.

---

## 4. Gerçek koşuların ortaya çıkardığı altı kusur (hepsi düzeltildi)

Bunların hiçbiri test edilerek bulunamazdı — canlı model gerekti.

1. **Tool yüzeyi sızıntısı.** `settingSources: []` yetmiyordu. Init mesajında
   `Task`, `Skill`, `Workflow`, `ToolSearch`, zamanlama tool'ları — 13 built-in
   her koşuya sızıyordu. Çağrılamıyorlardı ama prompt'u işgal ediyor ve host'a
   göre değişiyorlardı, yani iki makinedeki aynı görev karşılaştırılamazdı.
   `runQuery` artık `allowedTools` yanında `tools`'u da pinliyor.

2. **Replay modu kullanılamaz haldeydi.** Fixture'lar tam sorgu metnine göre
   adresleniyordu. Az önce kaydedilmiş bir görevi replay ettiğimde **16 aramanın
   16'sı ıskaladı**, skor 0.08. Bu mimari hakkında değil, fixture muhasebesi
   hakkında bir sayı. Artık ıska önce en yakın kayıtlı sorguya, sonra kayıtlı
   sayfaların kendisine düşüyor. `fetch_page` daha sıkı (aynı host + sayfayı
   adlandıran yol kuyruğu) — bu kural olmadan `.../HTTP/Status/301` ile
   `.../CSS/grid` %78 benzer çıkıyordu. Aynı görev: 0.08 → 0.86 → **1.00**.

3. **Kesilen turlar tüm işi çöpe atıyordu.** Turn/bütçe limitine çarpan koşu
   metinsiz hata sonucu döndürüyordu; ajan 12 sayfa okumuş, hiçbiri
   puanlanmıyordu. Artık son asistan mesajı transkriptten kurtarılıyor.
   Kesilmiş koşu geçerli bir veri noktasıdır.

4. **Bundler'a dayanmayan path çözümü.** `paths.ts` modül yüklenirken
   `import.meta.url` kullanıyordu; Next.js bunu bundle ederken `URL` farklı bir
   realm'den geliyor ve web build'i tamamen düşüyordu. Katmanlı çözüme geçti.

5. **Kimlik sızıntısı riski (canlı demo).** `process.env`'i yayıp ziyaretçi
   anahtarı eklemek, sunucuda ortam kimliği varsa **site sahibine fatura
   ederdi**. `visitorEnv` tüm kimlik kaynaklarını siliyor. Bu makinede ortam
   Claude Code kimliği olduğu için kanıtlanabildi: geçersiz anahtar artık 401
   alıyor, önceden sessizce başarılı oluyordu.

6. **CLI aboneliği reddediyordu.** `arena run` `ANTHROPIC_API_KEY` yoksa çıkıyordu.
   SDK kimliği kendi sırasıyla çözüyor ve makinedeki Claude Code oturumu geçerli
   bir kimlik — kapı çalışan kurulumları reddediyordu. Artık hangi hesaba fatura
   edileceğini bildirip devam ediyor.

**Çalıştığı kanıtlanan şeyler:** atıf kontrolü canlı veride gerçek bir uydurma
yakaladı (ajan hiç açmadığı bir MDN sayfasını kaynak gösterdi; 8 atıftan 7'si
doğrulandı, ceza ×0.9375). Sandbox trace'i hedeflenen çözüm yolunu izliyor:
rezervasyonu oku → kuralları oku → yolcu tier'ını ayrı çağrıyla bul → iki
koordineli mutasyon, doğru tutarla.

---

## 5. Mac Mini'de çalıştırmak için

**Node 22+ kurulu değil.** (Kurulumu kasıtlı olarak yapmadım, senin tercihin.)
nodejs.org'dan macOS arm64 installer, ya da brew kurup `brew install node@22`.

Sonra:

```bash
cd ~/development/agent-arena
npm install
npm run check          # typecheck + 437 test
npm run check:wiring   # SDK/MCP kablolama canary'si
npm run dev:web        # http://localhost:3210
```

Benchmark koşmak için anahtar gerekmiyor — makinedeki Claude Code oturumu
kullanılıyor, faturası o hesaba gidiyor:

```bash
npm run arena -- tasks
npm run arena -- run --strategies single --tasks airline-easy --repeats 1 --model claude-sonnet-5
npm run arena -- report
```

⚠️ **Araştırma görevleri için fixture'lar repo'da geliyor (52 dosya), yeniden
kaydetmen gerekmiyor.** Yeni araştırma görevi eklersen `--record` ile bir kez
koş.

---

## 6. Sırada ne var

Tavan etkisini kırmak için üç yol:

- **A. Zorluğu yükselt** — mevcut dünyalara daha çok kural etkileşimi olan
  görevler ekle. Doğru uzun vadeli yatırım. Rehber: `docs/ADDING-A-TASK.md`.
- **B. Araştırma yarısını koştur** — 3 araştırma görevi hiç matrise girmedi.
  Tek koşuda 1.00 / 0.86 / 0.49 çıkmıştı, yani orada gerçek varyans var.
  5×3×2 = 30 koşu, ~$5.
- **C. Bütçeyi kıs** — `--max-cost` ve `maxTurns`'ü daraltıp mimarileri kaynak
  baskısı altında test et. Kod değişikliği gerektirmiyor.

**B + C** en hızlı gerçek sinyali verir; **A** kalıcı çözüm.

README artık bu bulguyu tam olarak taşıyor: açılış paragrafında null sonucun
kabulü, `Results` bölümünde gerçek 90 koşuluk tablo ve dürüst okuması,
`Limitations`'ın en başında ölçülmüş tavan etkisi, ve yeni bir
`What running it actually surfaced` bölümünde canlı koşuların ortaya çıkardığı
altı kusur.

---

## 7. Bilinçli bırakılanlar

- `npm audit` orta seviye uyarılar veriyor (Agent SDK'nın geçişli bağımlılığı +
  vitest'in esbuild'i). `--force` düzeltmesi Agent SDK'yı geri alırdı; bilerek
  bırakıldı, README'de yazıyor.
- Canlı demo (`/live`) ziyaretçinin kendi API anahtarını ister — abonelik
  kimliğiyle üçüncü taraflara servis vermek SDK'nın kullanım yönergesine aykırı,
  ve `visitorEnv` bunu teknik olarak da engelliyor.
- `results/**/traces/` gitignore'da (büyük); istisna `demo-synthetic` — trace
  viewer'ı benchmark koşmadan inceleyebilmek için.
