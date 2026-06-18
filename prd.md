# Product Requirement Document (PRD) - Verified Version

## 1. Project Overview & Target
* **Project Name:** Global Open API-based Fixed Broadband Quality Dashboard
* **Target Audience:** Network Operations (NW 운용) and Network Management (NW 관리) Departments
* **Primary Objective:** Build a zero-infrastructure-cost, high-reliability fixed broadband quality dashboard using free global open APIs, enabling cross-ISP quality comparison and routing topology tracking for executive-level reporting.

---

## 2. Technical Stack & Cost Constraints
* **Architecture:** Serverless / Frontend-driven Architecture
* **Backend:** Serverless Functions (e.g., Vercel Functions / AWS Lambda) acting as an API Gateway to mask credentials and route queries.
* **Frontend:** Single Page Application (React / Vue / Vanilla JS) with dynamic charting libraries (e.g., ApexCharts, Chart.js).
* **Storage:** No persistent backend database. On-demand fetching with client-side time-series buffer.
* **Cost Target:** 100% Free Tier utilization (Optimized API query ranges and data payload sizes).

---

## 3. Targeted ISPs & Autonomous System Numbers (ASNs)
The application must aggregate and display metrics mapped to specific ASNs, grouped and prioritized as follows:

### 3.1 Pinned / Domestic ISPs (Top of the list)
* **KT:** `AS4766`
* **SK Broadband:** `AS9318` (Dedicated Fixed Line) / *Option: `AS9644` (SKT Mobile - Must be toggleable to prevent wireline data pollution)*
* **LG U+:** `AS3786`, `AS17858` (Merge capable)

### 3.2 Global ISPs (Grouped by Region)
* **USA:** Comcast Xfinity (`AS7922`), AT&T (`AS7018`), Charter Spectrum (`AS20115`), Verizon Fios (`AS701`), Cox (`AS22773`), Lumen/CenturyLink (`AS209`)
* **Canada:** Bell (`AS577`), Rogers (`AS812`), Telus (`AS852`), Shaw (`AS6327`)
* **United Kingdom:** BT (`AS2856`), Virgin Media (`AS5089`), Sky (`AS5607`), TalkTalk (`AS13285`)
* **Germany:** Deutsche Telekom (`AS3320`), Vodafone DE (`AS3209`), 1&1 (`AS8881`)
* **France:** Orange (`AS3215`), Free/Iliad (`AS12322`), SFR (`AS15557`), Bouygues (`AS5410`)
* **Italy:** TIM (`AS3269`), Fastweb (`AS12874`), Vodafone IT (`AS30722`)
* **Spain:** Telefónica/Movistar (`AS3352`), Orange ES (`AS12479`), Vodafone ES (`AS12430`)
* **Netherlands:** KPN (`AS1136`), VodafoneZiggo (`AS33915`)
* **Japan:** NTT/OCN (`AS4713`), KDDI/au (`AS2516`), SoftBank (`AS17676`), So-net (`AS2527`)
* **Australia:** Telstra (`AS1221`), TPG (`AS7545`), Optus (`AS4804`)

---

## 4. Functional Requirements (FR)

### [FR-01] 10-Minute Interval On-Demand Data Scraping
* The Serverless gateway must query data from target APIs mapping to a **10-minute interval grid** ($6\text{ data points per hour}$).
* Query range constraints: Restrict maximum chronological lookup windows (e.g., 30 to 90 days) to comply with free-tier usage boundaries and optimize BigQuery scan volumes.

### [FR-02] Core Data Sources & Extraction Metrics
The system must parse, isolate, and normalize the following metrics from the three free data providers:
1. **Cloudflare Radar API:**
   * `LATENCY` (Average Round-Trip Time to Cloudflare Edge in ms)
   * `JITTER` (Standard deviation of latency variation in ms)
   * `BANDWIDTH` (Estimated baseline throughput in bps)
   * `HTTP_ERROR_RATE` (Connection failure/timeout ratios in %)
2. **M-Lab API (ndt7 Engine via BigQuery):**
   * `MeanThroughputMbps` (Sustained bulk TCP download/upload speeds)
   * `MinRTT` (Baseline physical layer propagation delay in ms)
   * `LossRate` (TCP retransmission-based packet drop ratio in %)
   * Kernel TCP Parameters: `Cwnd` (Congestion Window), `PacingRate`
3. **RIPE Atlas API (Built-in Measurements):**
   * Ping telemetry (`min`, `avg`, `max` RTT and packet success ratio for Availability %)
   * Traceroute metrics (`hops` count, `as_path` flapping detection to global destinations)
   * DNS Metrics: `rt` (3-ISP Local DNS resolve response times in ms)

### [FR-03] Core Reliability Pipe: Outlier Trimming & Garbage Filtering
> **CRITICAL REQUIREMENT:** The data must be verifiable and free of edge-user terminal noise (e.g., poor local Wi-Fi, heavy local CPU load) before presentation.
* **Trimmed Mean Execution:** For every consolidated time bucket (1-Hour or 1-Day views), sort the array of samples and **discard the top 5% (overshoots) and bottom 5% (local noise/failing terminals)**. Calculate the mean and median using the remaining 90% of data.
* **Sample Size Validator:** If a specific ASN contains fewer than $N$ samples (Threshold default: $N = 10$ for 10-Min grids, $N = 50$ for Daily charts) within the selected time bucket, render the segment as a dotted line with a "Low Sample Volume" tooltip to prevent statistical skewing.
* **Hard Threshold Filter:** Drop measurements violating sane network limits (e.g., `Latency > 500ms` on domestic hops, or throughput metrics scaling higher than physical link capacity limits without network events).

### [FR-04] Peak-Time Performance Degradation Analyzer
* The UI must feature a dedicated analytical widget tracking Peak-Time degradation.
* Calculate and display **Peak-Time Throughput Defense Rate (%)** and **Latency Spike Rate (%)** by contrasting Busy Hours (21:00 - 23:00) against Quiet Hours (02:00 - 05:00).

### [FR-05] High-Resolution Multi-Select Dropdown Interface
* **UI Component:** A collapsible single-dropdown menu housing checkboxes for all ASNs.
* **Resolution Specification:** When expanded, the menu panel must scale vertically to occupy exactly **up to 80% of the viewport height (80vh) on standard 1080p displays**, with an independent internal vertical scrollbar (`overflow-y: auto`).
* **Visual Hierarchy:** Pinned Korean ISPs sit fixed at the top; international groups follow below, collapsible by nation.

### [FR-06] Black & White Theme System (Dark / Light Mode)
* Provide a clean toggle mechanism in the global toolbar to instantly alternate styling parameters.
* **Black Theme:** Background `#121212`, Surface `#1E1E1E`, Text `#FFFFFF` (High-contrast charting stroke rules).
* **White Theme:** Background `#FFFFFF`, Surface `#F5F5F5`, Text `#000000` (Standard contrast graphing rules).
* **State Persistence:** Cache the selected theme state inside `LocalStorage` to persist settings across session reloads.

---

## 5. Non-Functional Requirements (NFR)
* **Data Transparency & Traceability:** Hovering over any time-series coordinate must reveal meta-metrics: `[Total Samples, Trimmed Samples Count, Net Retained Ratio (%)]` to enable quick cross-verification with official government metrics (NIA/MSIT reports).
* **Security & Credential Masking:** Strict prohibition of environmental API tokens inside client-side builds. All authorization headers must be processed exclusively via Serverless infrastructure variables (`process.env`).
* **Chart Adaptability:** Ensure chart line states dynamically mutate schema modes (`mode: 'dark' | 'light'`) concurrently with the global theme switch without requiring a hard page refresh.