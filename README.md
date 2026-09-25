# Codex JEV Desktop Router

Windows 11 üzerinde Codex'in mevcut hesabını ve Responses akışını kullanan yerel yönlendirme katmanı. TypeSafe JEV yalnızca karar verir; yanıtı gerçek Codex modeli üretir. JEV model sınıfı, reasoning effort, çalışma sırası, risk ve en fazla iki bağımsız alt görev önerir.

## Özellikler

- Kurulum, `jev_desktop` sağlayıcısını ve `jev-auto` modelini kullanıcı düzeyindeki Codex ayarına yedek alarak ekler.
- `CodexJevDesktopRelay` Windows görevi röleyi kullanıcı oturumu açıldığında düşük yetkiyle başlatır. Röle yalnızca `127.0.0.1:4319` dinler.
- Model listesi hesabın canlı kataloğundan alınır; farklı Desktop/CLI sürümleri ve hesaplar birbirinden ayrılır.
- Aynı konuşma içinde model/effort değişimi, bağlamın korunması ve uygulanan rotayı gösteren cevap dipnotu desteklenir.

## İlk kurulum

Windows 11, Node.js 22 veya üzeri, kurulu ve hesabına giriş yapılmış Codex Desktop ve bir TypeSafe API anahtarı gerekir. Bu depo anahtar veya hazır kullanıcı ayarı içermez. Her kullanıcı kendi hesabını ve anahtarını kullanır.

1. Depoyu kalıcı bir dizine klonla; aşağıdaki komutları o dizinde çalıştır.
2. `npm ci`, `npm run check` ve `npm test` ile kurulumu doğrula.
3. `node bin/jev-desktop.mjs secret set` komutuyla kendi terminalinde anahtarını gizli girişle kaydet.
4. `node bin/jev-desktop.mjs startup-install` ve `node bin/jev-desktop.mjs startup-start` ile arka plan görevini kur ve başlat.
5. `node bin/jev-desktop.mjs active`, ardından `node bin/jev-desktop.mjs install-preview` ile değişiklikleri incele. `node bin/jev-desktop.mjs install` kullanıcı düzeyindeki Codex ayarını değiştirir ve yedekler.
6. Codex'in hook inceleme ekranından yalnız bu projenin `UserPromptSubmit` hook'unu inceleyip güvenilir olarak işaretle. Hook güveni kullanıcı tarafından verilmelidir.
7. Codex'i yeniden açıp `Jev Auto` seç; `node bin/jev-desktop.mjs doctor` ile sağlığı kontrol et.

Bu resmî bir OpenAI veya TypeSafe ürünü değildir. Codex sürümüne ve hesap erişimine göre uyumluluk değişebilir. Ayrıntılar: [mimari ve veri akışı](docs/ARCHITECTURE.md), [özel depo paylaşımı](docs/SHARING.md).

## Kullanım

PowerShell'de proje dizinine geç:

```powershell
cd "<deponun-bulundugu-dizin>"
node bin/jev-desktop.mjs doctor
node bin/jev-desktop.mjs doctor --deep  # Model listesi ve TypeSafe erişimini de sınar
node bin/jev-desktop.mjs explain
node bin/jev-desktop.mjs report
node bin/jev-desktop.mjs models  # İstemci sürümüne göre gerçek katalog ve eşlemeler
```

Codex Desktop model seçicisinde `Jev Auto` görünürse onu seç. Mevcut oturum açıkken görünmüyorsa Codex Desktop'ı yeniden aç. Varsayılan ayar da `jev-auto` olduğu için yeni yerel oturumlar bu sağlayıcıyı kullanır.

`Jev Auto` seçiliyken reasoning göstergesini `medium` seviyesinde bırak. Bu yalnız başlangıç değeridir; her yeni turda gerçek model ve gerçek effort (`low`, `medium`, `high` veya `xhigh`) JEV kararıyla değiştirilir. TypeSafe yanıt vermezse röle son güvenli rotayı veya `standard/high` başlangıç rotasını kullanır.

Windows oturum açılış görevi röleyi penceresiz bir başlatıcı üzerinden çalıştırır; konsolun açık kalması gerekmez. Röle süreci kapanırsa başlatıcı 3 saniye bekleyip yeniden açar. Görev tamamen durursa dakikalık tetikleyici yeniden başlatmayı dener (zaten çalışıyorsa ikinci süreç açılmaz). Codex bir mesaj gönderirken röle kapalıysa güvenilir hook aynı görevi tekrar başlatmayı da dener. Codex'i normal biçimde kapatıp açmak röleyi durdurmaz. Başlangıç veya toparlanma sırasında bir istek hata alabilir; gerçek internet/OpenAI kesintisini bu mekanizma gidermez. `serve` komutunu elle çalıştırmak ise ön planda çalışma içindir.

Başlatıcı Windows Job Object ile kendi Node sürecini sahiplenir; görev durduğunda Node da kapanır. Başlama, çıkış ve hata kayıtları `%LOCALAPPDATA%\CodexJevDesktop\supervisor.log` içinde boyutu sınırlı olarak tutulur. Başlatıcı kaynak dosyası `bin/jev-supervisor.cs`, yerel derlenmiş çıktısı `.runtime/` içindedir. `powershell.exe -NoProfile -File scripts/test-supervisor.ps1` gerçek röleye dokunmadan kapanma, yeniden başlama ve sahipsiz süreç kontrolünü sınar.

Modlar:

```powershell
node bin/jev-desktop.mjs active   # JEV kararını uygula
node bin/jev-desktop.mjs shadow   # Kararı ölç, mevcut güvenli rotayı kullan
node bin/jev-desktop.mjs bypass   # JEV çağrısı yapmadan mevcut/güvenli rotayı kullan
node bin/jev-desktop.mjs auto     # Bypass ve manuel override'ı kaldır
node bin/jev-desktop.mjs footer-on  # Final yanıtta model / effort satırını göster
node bin/jev-desktop.mjs footer-off # Bu satırı gizle
node bin/jev-desktop.mjs astra-rescue-only # Astra yalnız tekrarlanan Sol/high başarısızlıklarından sonra
node bin/jev-desktop.mjs astra-auto        # Astra için olağan otomatik seçimi geri aç
```

Route dipnotu varsayılan olarak açıktır. Modelden `Jev Auto` final cevaplarının sonuna `JEV route: gpt-6-sol · high` biçiminde uygulanan son model/effort çiftini yazması istenir. Bu, modele verilen bir sunum talimatıdır; özel çıktı biçimleriyle çatışırsa her cevapta görünmesi garanti edilmez. Araç adımlarına, çalışma güncellemelerine ve compaction isteğine eklenmez.

Model kataloğu istemci sürümü ve kimlik doğrulama kapsamına göre ayrı tutulur. Katalog alınırken Codex'in istemci sürümü upstream'e iletilir; eski bir CLI'nin listesi Desktop listesinin üzerine yazılmaz. Tanılama betikleri Windows'ta kurulu Desktop yürütülebilir dosyasını tercih eder. `JEV_CODEX_EXECUTABLE` ile belirli bir yürütülebilir dosya seçilebilir.

Bu Desktop kataloğunda otomatik sınıflar: hızlı = GPT-6 Luna, standart = GPT-6 Sol, en güçlü = GPT-6 Astra. JEV otomatik effort seçiminde `low`, `medium`, `high`, `xhigh` kullanır; katalogdaki `max`/`ultra` otomatik karar uzayına dahil değildir. Önceki nesil modeller katalogda manuel seçim için kalır.

`astra-rescue-only` kalıcı ayarı açıkken Astra normal başlangıçta, risk/düşük güven gerekçesiyle veya otomatik fallback olarak seçilmez. Aynı kullanıcı turunda standart modelin high veya üzeri effort ile en az iki ayrı başarısız araç denemesi görülmeli; JEV ayrıca yüksek güvenle `strongest` seçmelidir. Aynı sonucun tekrar iletimi sayılmaz; tanınan ağ/yetki hataları model yetersizliği sayılmaz. Astra o kurtarma turunda sürdürülebilir, yeni kullanıcı turunda Luna/Sol havuzuna dönülür. Bu ölçüt modelin gerçekten tıkandığının kusursuz bir tespiti değildir; yalnız metinsel konuşmadaki başarısızlıkları otomatik olarak saymaz. Alt ajanlara aynı tercih talimatla iletilir. Kullanıcının Codex seçicisinden doğrudan seçtiği modeller bu otomatik yönlendirme kuralının dışındadır.

### Kullanılacak modelleri belirleme

Sohbette “JEV havuzundan GPT-6 Luna'yı çıkar”, “yalnızca GPT-6 Sol ve Astra kullan” veya “Luna'yı geri ekle” diyerek bu ayarları asistana uygulatabilirsin. Metin içindeki model adları kendiliğinden kalıcı ayar değiştirmez; asistan yerel yönetim komutuyla açık isteğini uygular.

```powershell
node bin/jev-desktop.mjs model-policy
node bin/jev-desktop.mjs model-disable gpt-6-luna
node bin/jev-desktop.mjs model-enable gpt-6-luna
node bin/jev-desktop.mjs model-only gpt-6-sol gpt-6-astra
node bin/jev-desktop.mjs model-reset
```

Bu ayar kalıcıdır ve `Jev Auto` üzerinden geçen isteklerde uygulanır; yasaklı model mevcut rota, manuel override, fallback veya alt ajan önerisinden geri gelemez. Bütün modelleri kapatma isteği reddedilir. Tek bir model kimliğini çıkarmak aynı ailenin eski sürümlerini çıkarmaz; yalnız belirli modeller için `model-only` kullan. `model-enable` yalnız listesi varsa modele o listede de izin verir. `model-reset` kısıtları kaldırır; `auto` komutu model havuzunu sıfırlamaz. Hesapta olmayan bir model eklenemez. Codex seçicisinden doğrudan seçilen gerçek modeller ve Codex'in ayrıca başlattığı ajanlar bu havuzun zorunlu denetimi dışındadır.

Anahtarı yenilemek için `node bin/jev-desktop.mjs secret set` komutunu **kendi PowerShell terminalinde** çalıştır; anahtarı sohbete yazma. Röleyi yeni anahtarla yeniden başlatmak için `node bin/jev-desktop.mjs startup-restart` kullan. Durdurma ve başlatma aynı işlemde yapılır; çalışan bir yanıtın ortasında çalıştırma.

Eski bağlamı aramak için `node bin/jev-desktop.mjs memory --session <Codex-session-id> <aranacak-kelimeler>` kullan. Arşivi silmek için `node bin/jev-desktop.mjs memory-clear` kullan. Varsayılan karar kayıtları prompt içermez; yerel hafıza arşivi redakte edilmiş mesaj ve araç kanıtı içerir ve `%LOCALAPPDATA%\CodexJevDesktop` altındadır.

Bir iş bittikten sonra seçilen rotanın sonucunu yerel kalibrasyon verisine ekleyebilirsin:

```powershell
node bin/jev-desktop.mjs calibrate small_edit success 0 --elapsed-ms 1200
node bin/jev-desktop.mjs calibrate unknown_cause_bug failure 2 --session <Codex-session-id> --escalated
node bin/jev-desktop.mjs report
```

Görev türleri: `typo`, `small_edit`, `unit_test`, `simple_bug`, `known_cause_bug`, `unknown_cause_bug`, `multi_file_refactor`, `whole_repo_refactor`, `architecture`, `security_review`, `migration`, `agentic_research`. `--session` verilmezse son karar etiketlenir. Kayıt model, effort, sonuç, tekrar sayısı, süre ve varsa ölçülen token kullanımını içerir; prompt içermez. Sonuç etiketleri otomatik üretilmez.

## Geri alma

```powershell
node bin/jev-desktop.mjs uninstall
```

Bu komut Codex ayarını yedekten geri getirir ve yalnızca projeye ait Windows görevini kaldırır. Röle kapanmışsa aynı komutu normal PowerShell terminalinde çalıştır. Başka ayarlarla çakışma varsa üzerine yazmak yerine hata bildirir.

## Teknik sınırlar

- Çalışan röle, JEV hata verdiğinde mevcut veya güvenli modeli kullanır. Röle süreci kapanırsa Codex'in yerel sağlayıcıya geçmesi ya da rölenin yeniden başlaması gerekir.
- Model değişirken Codex'in kanonik isteği ve aynı thread'i korunur. Sonsuz ve kelimesi kelimesine hafıza garanti edilemez; Codex'in bağlam penceresi ve compaction kuralları geçerlidir.
- Task mode ve alt ajan sayısı/modeli hook üzerinden öneridir. Gerçek Plan modu ve alt ajan oluşturma kararı Codex'tedir.
- Model sınıfları ve desteklenen effort düzeyleri canlı model kataloğundan seçilir. Kullanıcı hesabında bulunmayan model zorlanmaz.
- Başlangıç görevi bu proje klasörünü ve mevcut Node.js yürütülebilir dosyasını kullanır. Bunlar taşınırsa görevi yeniden kurmak gerekir.

Bağımlılık yoktur; `npm test` ve `npm audit` ile doğrulanır. İstekler varsayılan olarak yalnızca TypeSafe, ChatGPT Codex ve OpenAI API adreslerine gider. TypeSafe anahtarı OpenAI'ye, Codex Authorization başlığı TypeSafe'e iletilmez. Mimari ve kaynaklar için [belge](docs/ARCHITECTURE.md) bulunur.
