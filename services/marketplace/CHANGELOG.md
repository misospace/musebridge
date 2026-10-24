# Changelog

## [0.1.1](https://github.com/misospace/musebridge/compare/v0.1.0...v0.1.1) (2026-10-24)


### Features

* **marketplace:** add action authorization gate ([a6a8189](https://github.com/misospace/musebridge/commit/a6a818948928a18f67e24cc83ae769197f974c83))
* **marketplace:** add action authorization gate ([35a68e6](https://github.com/misospace/musebridge/commit/35a68e6bb5e1af9c529e6cd950de5641a422f80d))
* **marketplace:** add ebay shopping backend ([3b77837](https://github.com/misospace/musebridge/commit/3b7783782cbeec7fea45ab6b59b7c436dc701792))
* **marketplace:** document provider architecture and expose capability discovery ([#40](https://github.com/misospace/musebridge/issues/40)) ([#65](https://github.com/misospace/musebridge/issues/65)) ([ddc6de0](https://github.com/misospace/musebridge/commit/ddc6de0f0749684ff5b8e6408d2a8876de24eeec))
* **marketplace:** eBay shopping surface, fixture-first ([#48](https://github.com/misospace/musebridge/issues/48)) ([d3b87fb](https://github.com/misospace/musebridge/commit/d3b87fb9dff87e5adb657612e11c27c991feec0e))
* **marketplace:** events availability surface + reservations/events research ([#50](https://github.com/misospace/musebridge/issues/50)) ([#71](https://github.com/misospace/musebridge/issues/71)) ([c50ae00](https://github.com/misospace/musebridge/commit/c50ae003d937ee880faf5a2a9f982d9d10ba6dd4))
* **marketplace:** facebook messenger conversation read backend ([2e31cee](https://github.com/misospace/musebridge/commit/2e31cee5bebc618f8a3dc56ad9a5d7ae40efcabb))
* **marketplace:** messenger surface scope with read-only conversation tools ([9ec223d](https://github.com/misospace/musebridge/commit/9ec223ddac7f21e705c71f95b28b5e1538310bef))
* **marketplace:** messenger_prepare draft with subject_digest ([#62](https://github.com/misospace/musebridge/issues/62)) ([#106](https://github.com/misospace/musebridge/issues/106)) ([4254874](https://github.com/misospace/musebridge/commit/42548744d2529c6288b5e0f45d13a60fe362c4c8))
* **marketplace:** messenger_send with HMAC authorizer, durable consumption, delivery observation ([#75](https://github.com/misospace/musebridge/issues/75)) ([92c913f](https://github.com/misospace/musebridge/commit/92c913ffeb44b16218bcd10920ad473c33136bc8))
* **marketplace:** pin cross-site shopping data contract ([ef6acec](https://github.com/misospace/musebridge/commit/ef6acecc079adf5465e35f129b0242b86be26cdc))
* **marketplace:** read-only seller conversation tools ([#43](https://github.com/misospace/musebridge/issues/43) step 1) ([96487c9](https://github.com/misospace/musebridge/commit/96487c9f2c8ba073f331429d7ad4e3c645fcb73f))
* **marketplace:** Threads read-only surface (own posts and reply trees) ([#103](https://github.com/misospace/musebridge/issues/103)) ([3f03094](https://github.com/misospace/musebridge/commit/3f030945366c0c10bf35829efc2e12770ddce11c))
* **marketplace:** wire shopping tools ([e38eb04](https://github.com/misospace/musebridge/commit/e38eb04f0b69e9ac40ee67d6dfdfe81d7fc94bdb))


### Bug Fixes

* **deps:** update dependency @modelcontextprotocol/sdk (1.32.1 → 1.32.2) ([#136](https://github.com/misospace/musebridge/issues/136)) ([177350b](https://github.com/misospace/musebridge/commit/177350b22c503071cf5ae49fbbb049b46e8c441b))
* **deps:** update dependency @types/node (24.19.1 → 24.19.2) ([2799495](https://github.com/misospace/musebridge/commit/2799495857019c259a2bd1e9aa15d1b39c512e7e))
* **deps:** update dependency @types/node (24.19.1 → 24.19.2) ([633d539](https://github.com/misospace/musebridge/commit/633d539d309d7b4b4855cba853a466c257fc97fa))
* **deps:** update dependency playwright (1.64.0 → 1.64.1) ([31fedb4](https://github.com/misospace/musebridge/commit/31fedb4d0ad5abc298efdc9e306998c150970a61))
* **deps:** update dependency playwright (1.64.0 → 1.64.1) ([bcefd17](https://github.com/misospace/musebridge/commit/bcefd172c4a8d31bd300f59251bff3ae4ad419a4))
* **deps:** update dependency vitest (5.0.3 → 5.0.4) ([374449f](https://github.com/misospace/musebridge/commit/374449fdd87a755e9a272a7a942be0cbb6474cec))
* **deps:** update dependency vitest (5.0.3 → 5.0.4) ([e985de0](https://github.com/misospace/musebridge/commit/e985de01d4b45a0a49599643f6b6a41a68971b48))
* **deps:** update dependency vitest (5.0.4 → 5.0.5) ([0d470da](https://github.com/misospace/musebridge/commit/0d470daa710d6e4310dd534bcdcb127e02cae20b))
* **deps:** update dependency vitest (5.0.4 → 5.0.5) ([cfc7acb](https://github.com/misospace/musebridge/commit/cfc7acb071ff186358a80acfa22850ae72b497c2))
* **deps:** update dependency zod (4.6.5 → 4.6.6) ([db226be](https://github.com/misospace/musebridge/commit/db226be1c4492308c476aaabcc2dc0f7e29818b2))
* **deps:** update dependency zod (4.6.5 → 4.6.6) ([6ab5867](https://github.com/misospace/musebridge/commit/6ab58673090bd18ecfaddc874a52d2ba63bb2b6a))
* **deps:** update dependency zod (4.6.6 → 4.6.7) ([23108db](https://github.com/misospace/musebridge/commit/23108dbbf25394b6241f17827e63e9939aa4b3aa))
* **deps:** update dependency zod (4.6.6 → 4.6.7) ([734023b](https://github.com/misospace/musebridge/commit/734023bab3a9079be7949d4f40cd71531aa62d92))
* **marketplace:** align ebay backend with house patterns ([21a5daf](https://github.com/misospace/musebridge/commit/21a5dafcb15c8dfb835af2de44dd9976a1d8850c))
* **marketplace:** bound requestTimeoutMs to the 32-bit setTimeout range ([#138](https://github.com/misospace/musebridge/issues/138)) ([240f76b](https://github.com/misospace/musebridge/commit/240f76badedbe41c5d8b430d2d8c31d75b77e755))
* **marketplace:** bound shared eBay OAuth refresh and recover after stalled responses ([#118](https://github.com/misospace/musebridge/issues/118)) ([a674f7d](https://github.com/misospace/musebridge/commit/a674f7de29ee5022ca808ae68780451085caa676))
* **marketplace:** close ebay mapping coercion traps ([efeaffb](https://github.com/misospace/musebridge/commit/efeaffbc3808518d47a5f4cbf75e056992f8b459))
* **marketplace:** fail startup when browser scopes share a profile directory ([17751ab](https://github.com/misospace/musebridge/commit/17751abad23db158ec462c3bf8c3a5b7d39f94f8))
* **marketplace:** ignore non-rendered page copy ([#94](https://github.com/misospace/musebridge/issues/94)) ([2eb8949](https://github.com/misospace/musebridge/commit/2eb8949a3a5a3d46a3ab62b5024fa0edde9461b0))
* **marketplace:** normalize eBay Retry-After hints before provider error validation ([#116](https://github.com/misospace/musebridge/issues/116)) ([#121](https://github.com/misospace/musebridge/issues/121)) ([7cc7c61](https://github.com/misospace/musebridge/commit/7cc7c615c66f44a1f22b836448b28fa25b33aa74))
* **marketplace:** precise condition mapping and locked credential destination ([3d5c114](https://github.com/misospace/musebridge/commit/3d5c11452b4b1223cf884e7f2014a0a8baa2b1cb))
* **marketplace:** reject malformed Threads paging containers instead of claiming completeness ([#126](https://github.com/misospace/musebridge/issues/126)) ([6a7afee](https://github.com/misospace/musebridge/commit/6a7afee0ee0d0cb53aefbcc9ab007e2ef752fade))
* **marketplace:** restore messenger inbox thread listing from passive GraphQL responses ([#81](https://github.com/misospace/musebridge/issues/81)) ([42d77d5](https://github.com/misospace/musebridge/commit/42d77d56d82f2ff4d91a0aa5425fbf0cd25f0867))
* **marketplace:** restore variant identity and correct eBay access research ([951bcaa](https://github.com/misospace/musebridge/commit/951bcaaeeac41f13ac385db1e5167b0e28ef997c))
* **marketplace:** share Retry-After normalization on current main ([#124](https://github.com/misospace/musebridge/issues/124)) ([b8290ea](https://github.com/misospace/musebridge/commit/b8290ea8d9bd21490580b803dc0fa37eb9c12581))
* **marketplace:** sync service version with releases ([7444fcc](https://github.com/misospace/musebridge/commit/7444fcc93a554e0d7c734be7ea21b4357f3f4461))
* **marketplace:** sync service version with releases ([4e60b33](https://github.com/misospace/musebridge/commit/4e60b3317322ae97e5a7ecb3590935a70bfc4bb8))
* **marketplace:** trust conversation pages only at their expected address ([ab57021](https://github.com/misospace/musebridge/commit/ab57021cda99aff876ee78088082a1b77f9f6e6e))
* **marketplace:** type the captured marketplace header for multi-value headers ([f12553f](https://github.com/misospace/musebridge/commit/f12553fc12f162d47767383f7eba8d71d3c273df))
* **marketplace:** verify credential login on the login's own surface ([63b9efc](https://github.com/misospace/musebridge/commit/63b9efc2117b438f8ca321235928bd6cba7b7a48))
* **messenger:** diagnose captcha probe signals ([#85](https://github.com/misospace/musebridge/issues/85)) ([3f95cc8](https://github.com/misospace/musebridge/commit/3f95cc8c0dc03b9222d624c35840985540b5af11))
* **messenger:** log challenge diagnostics ([#98](https://github.com/misospace/musebridge/issues/98)) ([b278672](https://github.com/misospace/musebridge/commit/b278672840b80ce293b68a4cf6e0bf30f53693f3))
* **messenger:** reject incomplete inbox listings ([#97](https://github.com/misospace/musebridge/issues/97)) ([693abdf](https://github.com/misospace/musebridge/commit/693abdf6efb7b6e8e575ec11ea1329b101579fb6))
* **messenger:** reject unverified thread layouts ([#87](https://github.com/misospace/musebridge/issues/87)) ([a9bdc81](https://github.com/misospace/musebridge/commit/a9bdc813a07ef06e629852ba88cb2d0e8795ba30))
* **messenger:** report SURFACE_DISABLED for probe-only valid session ([#88](https://github.com/misospace/musebridge/issues/88)) ([#104](https://github.com/misospace/musebridge/issues/104)) ([0c287e3](https://github.com/misospace/musebridge/commit/0c287e34ff0a5001cf17841f48622452163c61b1))


### Performance Improvements

* **marketplace:** test-only login timing overrides + CI/publish dedup ([a07fda8](https://github.com/misospace/musebridge/commit/a07fda88bd7f382b87df437f909f05c260739dd5))
* **marketplace:** test-only timing overrides for credential login ([10ecf26](https://github.com/misospace/musebridge/commit/10ecf26c3527ecd8b18c5854208bd35a16e66b21))


### Chores

* add trailing newlines to 14 tracked files ([#140](https://github.com/misospace/musebridge/issues/140)) ([daf22af](https://github.com/misospace/musebridge/commit/daf22af408afc7ab77b2723a8e428f986bf169b5)), closes [#125](https://github.com/misospace/musebridge/issues/125)
* **ci:** publish image as ghcr.io/misospace/marketplace-mcp ([35f546f](https://github.com/misospace/musebridge/commit/35f546f2758b00f4db0ec970d7a9357ede1aa892))
* **ci:** publish image as ghcr.io/misospace/marketplace-mcp ([175c6a1](https://github.com/misospace/musebridge/commit/175c6a14a2ceb4c39a046a68efe13c66c79915c2))
* **container:** update image node (8cabefb → 55fb5f5) ([#130](https://github.com/misospace/musebridge/issues/130)) ([fa256b8](https://github.com/misospace/musebridge/commit/fa256b830ed8c5f4b8abcc01d2234fc294cff6ab))
* **container:** update image node (91acba9 → 8cabefb) ([#129](https://github.com/misospace/musebridge/issues/129)) ([8b4cf1f](https://github.com/misospace/musebridge/commit/8b4cf1f8f1f39ca45dcba8ceaff3356f8c265f3f))
* **container:** update image node (a5f4366 → 91acba9) ([#127](https://github.com/misospace/musebridge/issues/127)) ([7ad033f](https://github.com/misospace/musebridge/commit/7ad033f55801e8272f723b199f659a9464b11c4c))
* **container:** update image node (d6aa754 → a5f4366) ([53e9fba](https://github.com/misospace/musebridge/commit/53e9fba2dd0e92c149f66c58509e4f5c963af399))
* **container:** update image node (d6aa754 → a5f4366) ([598609b](https://github.com/misospace/musebridge/commit/598609b96bb3cc65324d648d8d502ea52c64f8c6))
* **repo:** initialize marketplace ([d9aa1aa](https://github.com/misospace/musebridge/commit/d9aa1aa7d51fe5582ff8a94c0959ffb0e9205910))


### Documentation

* **marketplace:** clarify migration paths ([1379ce1](https://github.com/misospace/musebridge/commit/1379ce17ced03a92ddd1d679008db0cdfc2c1cf6))


### Styles

* **test:** restore separate import lines ([e146a2a](https://github.com/misospace/musebridge/commit/e146a2a6716ee46a40f228da6810ab4849c42601))


### Refactors

* consolidate duplicated timeout/abort helpers into timeout.ts ([#143](https://github.com/misospace/musebridge/issues/143)) ([8c11986](https://github.com/misospace/musebridge/commit/8c1198621872525a5df0181bfdca6ae814b519df))
* **marketplace:** declare tool capability requirements on the TOOLS entry ([#133](https://github.com/misospace/musebridge/issues/133)) ([b97642c](https://github.com/misospace/musebridge/commit/b97642cf96067644ef66d2dfaed2cecd33589279))
* **marketplace:** reject duplicate tool names on current main ([#134](https://github.com/misospace/musebridge/issues/134)) ([c19aac9](https://github.com/misospace/musebridge/commit/c19aac983c0293aba5bf241a31db8b4ea2a9b4ec))
* **marketplace:** require grant provenance before any send ([e3fd6c3](https://github.com/misospace/musebridge/commit/e3fd6c3f2c18c7f7b50fb00872d6b4cd8804bd92))
* **marketplace:** take CallTool output schemas from the TOOLS table ([#91](https://github.com/misospace/musebridge/issues/91)) ([#108](https://github.com/misospace/musebridge/issues/108)) ([24df186](https://github.com/misospace/musebridge/commit/24df186998d5ec40989f26a9bc0e5e8a54e2f7a5))
* **repo:** move marketplace into workspace ([178a4c8](https://github.com/misospace/musebridge/commit/178a4c83481cf8e855b74316f6c08ffbc1d6d977))
* **repo:** move marketplace into workspace ([799209d](https://github.com/misospace/musebridge/commit/799209d1a95f9a917728e3cab462f4f02c7ac8f8))
