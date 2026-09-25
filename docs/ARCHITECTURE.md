# Mimari ve veri akışı

## Bileşenler

- Codex, kullanıcı düzeyindeki özel Responses sağlayıcısı üzerinden `127.0.0.1:4319` adresine bağlanır.
- Node.js rölesi, hesabın ve istemci sürümünün canlı model kataloğunu ayrı önbelleklerde tutar.
- TypeSafe JEV sınırlı görev bağlamından model sınıfı, effort, görev modu, risk ve alt ajan önerisi üretir.
- Yerel politika bu kararı gerçekten kullanılabilen modellere eşler. Kalıcı model havuzu, manuel seçimler ve isteğe bağlı Astra kurtarma kuralı uygulanır.
- OpenAI/Codex yanıt akışı kullanıcıya aktarılır. Codex'in kanonik konuşma girdisi korunur; model/effort değiştirilir ve istenirse final rota dipnotu talimatı eklenir.
- Güvenilir `UserPromptSubmit` hook'u görev önerisini iletir ve röle kapalıysa Windows görevini başlatmayı dener. Alt ajan oluşturmayı Codex yönetir.

## Windows başlangıcı

Görev, oturum açılışında ve dakikalık toparlanma tetikleyicisiyle penceresiz C# başlatıcıyı çalıştırır. Aynı görev çalışıyorsa yeni örnek açılmaz. Başlatıcı, Node'u konsolsuz başlatır; süreç kapanırsa üç saniye sonra yeniden dener. Windows Job Object, görev kapandığında alt sürecin de kapanmasını sağlar. İnternet veya upstream servis kesintileri bundan bağımsızdır.

## Yerel veriler

Windows'ta çalışma verileri varsayılan olarak `%LOCALAPPDATA%\CodexJevDesktop` altındadır:

- TypeSafe anahtarı, yerel yönetim ve bağlantı belirteçleri;
- kullanıcı ayarları ve Codex yapılandırma yedekleri;
- yönlendirme kararları, kullanım/kalibrasyon kayıtları;
- redakte edilmiş konuşma ve araç kanıtı arşivi;
- sınırlı boyutta başlangıç/hata kayıtları.

Bu dosyalar paylaşılacak kaynak kodun parçası değildir. `.runtime/` içindeki derlenmiş başlatıcı, test çıktıları ve görev yedekleri de Git dışında kalır.

## Gizlilik sınırları

TypeSafe'e gönderilen görev metni üçüncü taraf veri aktarımıdır. Yerel metin filtreleri sır sızıntısını azaltır, tüm kişisel verileri tanıyacağı garanti edilmez. Codex yetki başlıkları TypeSafe'e, TypeSafe anahtarı OpenAI'ye gönderilmez. Yerel arşivlerin ve ayar yedeklerinin ayrıca paylaşılmaması gerekir. Özel GitHub deposu, uygulamanın çalışma anındaki veri akışını değiştirmez.

## Doğrulama ve sınırlar

Otomatik testler model eşlemesi, istemci/hesap ayrımı, anahtar ayrımı, model havuzu, kurtarma kuralı, canonical input, SSE, hafıza, geri alma ve hook toparlanmasını sınar. Windows başlatıcısı ayrı bir yerel sahte süreçle sınanır. Canlı denemeler gerçek hesap kullanır; `scripts/smoke-session.mjs` normalde Luna/Sol'u sınar. Astra için açıkça `--include-astra` gerekir ve kurtarma kısıtı açıksa bu isteği aşamaz.

Sınırsız hafıza, kesintisiz servis veya her Codex sürümüyle uyumluluk garantisi yoktur. Görev modu ve alt ajan önerileri Codex'in karar mekanizmasının yerine geçmez. Kullanım azalması ölçülmeden tasarruf iddiası sunulmaz.

## Tasarım kaynakları

Araştırmada [ansidium/jev-codex-bridge](https://github.com/ansidium/jev-codex-bridge), [gargpratyush/jev-router](https://github.com/gargpratyush/jev-router), [tiandee/codex-jev-router](https://github.com/tiandee/codex-jev-router), [flaviusapop/jev-router](https://github.com/flaviusapop/jev-router) ve [awesome-jev](https://github.com/hellogumbo/awesome-jev) incelendi. Bu depo kendi küçük röle ve politika uygulamasını içerir; kaynak projelerin uyumluluk iddialarını devralmaz.

Resmî başvurular: [Codex yapılandırması](https://developers.openai.com/codex/config-reference), [App Server](https://developers.openai.com/codex/app-server).
