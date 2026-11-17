# v1.0.7 — 撤回済み

この版のリリースとタグは撤回済みです。後継の公開版は [v1.0.8](https://github.com/kuraneko1/dsh-mobile-maxxing/releases/tag/v1.0.8) です。

以前の説明にあった「承認がComposerの席を差し替え、上流のResizeObserverが取り残される」という診断は誤りでした。実際の承認では同じ席が維持され、上流のobserverで高さも復帰します。不要な再計測処理は削除しました。

根本原因は、承認カードを質問カードと誤認し、祖先探索がアプリ全体のframeに到達したことです。次版では直親のframeだけを装飾し、誤って付いた属性も解除します。通常の入力欄には独立した左右16pxの余白を戻しています。

[承認済みの基準点](packages/dsh-mobile-maxxing/docs/approved-baseline-20261115.md) と [次版のドラフト](packages/dsh-mobile-maxxing/docs/release-next-draft.ja.md) を参照してください。2026-11-17のユーザー明示GOにより、後継版は[v1.0.8](RELEASE-NOTES-v1.0.8.md)として公開します。
