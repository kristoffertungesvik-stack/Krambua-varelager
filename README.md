# Krambua – Varelager

Digitalt varelager for Krambua Bensin & Storkiosk: **https://kristoffertungesvik-stack.github.io/Krambua-varelager/**

- **Skann** varer med kameraet på mobilen (eller handskannar) for å telje, ta imot varer eller sjå lagerstatus.
- **Sal frå kassa** (min.pckasse.no) og **ordrebekreftingar frå e-posten** vert henta inn automatisk kvar dag.
- Lager = siste teljing + mottak etter teljinga − sal etter teljinga.
- Berre fysiske salsvarer er med. Matservering, generiske kasseknappar (Kiosk 15 %, Jernvarer …), tenester og lausvekt er utelatne, men kan takast med per vare.

Sjølve tala ligg i det private repoet `Krambua-varelager-data`. Appen treng eit fine-grained GitHub-token med **Contents: Read and write** på det repoet (oppsett under «Meir» i appen).

Strekkodeskanning: [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) via [barcode-detector](https://github.com/Sec-ant/barcode-detector) (MIT), lagt ved i `lib/`. Android brukar den innebygde BarcodeDetector når han finst.
