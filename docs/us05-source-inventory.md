# US05 initial source inventory

Collected and screened on 2026-11-05 for the October 2024 Valencia DANA floods and October 2025 Hurricane Melissa in Jamaica. Owner is Jayson. Anson is the proposed reviewer.

All entries are pending staff approval and ingestion permission checks. This inventory is for team review. Keep it separate from the approved manifest and the searchable corpus. Dates in the table are publisher dates. A dash means no publication date was confirmed.

## Valencia DANA floods

Sources are in Spanish. Keep the original language for ingestion and use the English notes below to guide review.

| ID | Source and publisher | Published | Type | Evidence and limits |
| --- | --- | --- | --- | --- |
| VAL-01 | [Graves inundaciones en España](https://www.caritas.es/emergencias/graves-inundaciones/), Cáritas Española | — | Campaign candidate | The campaign has a donation link. Under “Nuestra acción en el terreno,” the Valencia section documents direct aid to families, housing rehabilitation, and support for schools. The campaign also covers areas outside Valencia. Confirm the final donation destination and whether gifts can be earmarked for Valencia. |
| VAL-02 | [Ayuda afectados inundaciones DANA](https://cercadeti.cruzroja.es/ayudaafectadosinundacionesdana), Cruz Roja Española | — | Campaign lead, needs verification | The URL returned a page with unresolved template fields. Check the rendered page and find a link to it from an official Cruz Roja publication before treating it as campaign evidence. Use VAL-05 for recovery context. |
| VAL-03 | [Spain’s government announces a block of a suspected fraudulent site](https://www.lamoncloa.gob.es/serviciosdeprensa/notasprensa/transformacion-digital-y-funcion-publica/Paginas/2024/081124-bloquea-web-ayuda-valencia-dana-por-fraude.aspx?mode=Light), La Moncloa | 2024-11-08 | Primary warning | The announcement describes blocking `ayudavalencia.es` following a report of fraudulent donation requests. This is historical evidence about the exact named host and the action announced on that date. |
| VAL-04 | [Donation scam roundup](https://maldita.es/timo/20241114/estafa-timo-dana-donacion-victimas/), Maldita.es | 2024-11-14 | Secondary warning context | Sections on fake volunteers, donation calls, and fraudulent sites document impersonation methods. Use VAL-03 as primary evidence for the government action. |
| VAL-05 | [DANA: dos años acompañando en la recuperación](https://www2.cruzroja.es/web/ahora/dana-dos-acompa%C3%B1ando-recuperacion), Cruz Roja Española | — | First-party recovery context | The housing rehabilitation and business recovery sections describe work in affected Valencia communities. The page supports claims about that work. Current campaign availability requires separate evidence. |

## Hurricane Melissa in Jamaica

Sources are in English.

| ID | Source and publisher | Published | Type | Evidence and limits |
| --- | --- | --- | --- | --- |
| JAM-01 | [Support Jamaica FAQs](https://www.supportjamaica.gov.jm/faqs), Government of Jamaica | — | Campaign candidate | The donation and use-of-funds FAQ entries identify the government portal and describe emergency relief, housing reconstruction, healthcare, and economic recovery. JAM-03 corroborates the government portal identity. Confirm the current donation flow and destination before approval. |
| JAM-02 | [Jamaica: Hurricane Melissa](https://www.ifrc.org/emergency/jamaica-hurricane-melissa), IFRC | — | Campaign candidate | The overview describes Jamaica Red Cross assistance with emergency shelter, food, water, and cash. The appeal links to an [IFRC campaign form](https://donate.redcrossredcrescent.org/ifrc/hurricane-melissa/) on a separate hostname. Review that exact path and its redirects. The page lists a dated emergency appeal document separately. |
| JAM-03 | [Hurricane Melissa donation website warning](https://opm.gov.jm/jamaica-cyber-incident-response-team-issues-urgent-warning-about-fraudulent-hurricane-melissa-donation-websites/), Jamaica Office of the Prime Minister, relaying JaCIRT | 2025-10-31 | Primary warning | The identified-domains section names eight suspected lookalikes, described at the time as being at various stages of development. Record the warning as historical and preserve the source’s qualification. The official-channel section identifies `www.supportjamaica.gov.jm` as the government portal. |
| JAM-04 | [Feeling forgotten](https://jamaica-gleaner.com/article/news/20251106/feeling-forgotten), The Jamaica Gleaner | 2025-11-05 | Reported impact | The article reports housing damage and residents’ accounts of water and shelter needs in parts of St Catherine. Use the displayed publication date, which differs from the date in the URL. The page shows an update on 2025-12-09. Treat the reported needs as historical and local to the communities discussed. |
| JAM-05 | [UNICEF Leads Child-Focused Response After Hurricane Melissa](https://www.unicef.org/jamaica/press-releases/unicef-leads-child-focused-response-after-hurricane-melissa), UNICEF Jamaica | 2025-11-07 | First-party response context | Documents UNICEF’s child-focused relief response and gives a donation direction as of the announcement. Use it as response context until a current, disaster-specific destination is verified separately. |

## Review and ingestion handoff

1. Check publisher terms and source permissions for storage, processing, and display of excerpts. Record the allowed use and method before adding any source to the approved manifest. Keep source snapshots in private storage.
2. Start with VAL-01, VAL-03, JAM-01, JAM-02, and JAM-03. Confirm extractable sections, event scope, and a source locator for each field the app will present. For multi-region pages, include only passages with explicit applicability to the selected disaster. Record any rejected source and why.
3. For each channel, verify the exact campaign destination, redirect chain, geographic coverage, and whether the campaign is still accepting donations. Record the staff reviewer, actual review time, evidence, and expiry when approved. Jamaica has two candidates for a comparison. Valencia has one candidate and one lead that needs more evidence.
4. Keep warning matches scoped to the named host or URL, with the original warning date and any later retraction or supersession. Use the publisher page as the citation. Treat named suspicious hosts as evidence text and avoid fetching them.
5. For the first chat smoke test, ask what Spain’s government reported about the suspected donation site in November 2024, then ask what JaCIRT warned about in October 2025. Check that citations come from VAL-03 and JAM-03 respectively and that the responses describe what was reported at the time.
