# Özel depo ve güvenli paylaşım

GitHub deposunun görünürlüğünü **Private** tut. Depo bağlantısını bilmek tek başına erişim sağlamaz; erişim için depo sahibinin daveti gerekir.

Arkadaş ekleme: depoda **Settings → Collaborators → Add people** yolundan GitHub kullanıcı adını seç ve davet gönder. Kullanıcı daveti kabul edince erişebilir. Bir kişiyi kaldırmak aynı ekrandan yapılır. Kişisel hesap depolarındaki collaborator erişimi yazma yetkisi de verebilir; yalnız okuma yetkisi gerekiyorsa GitHub organizasyonu ve uygun rol kullan.

Davet edilen kişi dosyaları indirebilir veya kopyalayabilir. Sonradan erişimi kaldırmak daha önce indirilmiş kopyaları silmez.

## Kaynak kodda bulunmaması gerekenler

- API anahtarları, erişim belirteçleri, `.env` dosyaları;
- kişisel Codex ayarları, kimlik bilgileri veya yapılandırma yedekleri;
- konuşma geçmişi, hafıza arşivi, rota/kullanım günlükleri;
- bilgisayar adı, gerçek kullanıcı dizinleri, kişisel e-posta ve kullanıcı SID'leri;
- `.runtime/` çıktıları ve yerel test/kurulum kayıtları.

`.gitignore` bunların yaygın dosya türlerini dışlar. Yalnız kaynak ve genel belgeler paylaşılır. Her yeni commit öncesi `node scripts/check-publish.mjs` ile **Git'e eklenmiş** dosyaları kontrol et. Bu kontrol bilinen anahtarlarla yerel karşılaştırma yapabilir; anahtar değerlerini çıktıya yazmaz. Otomatik tarama tüm olası kişisel verileri tanıyamaz; değişiklikleri ayrıca gözden geçir.

Commit yazarının adı ve e-postası Git geçmişinde görünür. Kişisel bilgilerin görünmesini istemiyorsan depo düzeyinde genel bir yazar kimliği veya GitHub'ın gizli e-posta seçeneğini kullan. Kaynak kod temizliği GitHub hesabının görünen adını veya profilini gizlemez.

Arkadaşlar kurulumda kendi Codex hesabını ve TypeSafe anahtarını kullanmalıdır. Çalışır kurulum dizinini veya AppData klasörünü topluca göndermeyin.
