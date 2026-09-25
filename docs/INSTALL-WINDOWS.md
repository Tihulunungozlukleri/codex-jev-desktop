# Başka bir Windows 11 bilgisayarına kurulum

Bu kılavuz, depoyu kendi bilgisayarına kuracak kişi içindir. Her kullanıcı kendi Codex oturumunu ve kendi TypeSafe API anahtarını kullanır. Depoda hazır anahtar, konuşma geçmişi veya kişisel Codex ayarı bulunmaz.

## Gerekenler

- Windows 11 ve normal kullanıcı hesabı;
- kurulmuş, açılmış ve hesaba giriş yapılmış Codex Desktop;
- Node.js 22 veya üzeri (`node --version`);
- Git (`git --version`) veya GitHub'dan indirilmiş kaynak ZIP'i;
- TypeSafe hesabından alınmış JEV API anahtarı;
- özel GitHub deposuna erişim daveti. Davet kabul edilmeden klonlama çalışmaz.

Projeyi kalıcı bir klasöre koy. Kurulumdan sonra klasörü taşırsan Windows başlangıç görevini yeniden kurman gerekir. Aşağıdaki komutları **PowerShell** içinde, projenin kök dizininde çalıştır.

## 1. Kaynağı al ve kontrol et

GitHub'da depoyu açıp **Code → HTTPS** adresini kopyala. Kendi erişiminle klonla; ilk komut adresi terminalde sorar. GitHub oturumu istenirse kendi hesabınla giriş yap:

```powershell
$repoUrl = Read-Host 'Özel deponun HTTPS adresi'
git clone $repoUrl
cd codex-jev-desktop
node --version
npm ci
npm run check
npm test
```

ZIP indirdiysen içeriği kalıcı bir klasöre çıkarıp `cd` ile o klasöre gir; `git clone` adımını atla. Node sürümü 22'nin altındaysa önce Node.js'i güncelle. Testler geçmiyorsa Codex ayarlarını değiştiren adımlara geçme.

## 2. TypeSafe anahtarını kendi bilgisayarında kaydet

```powershell
node bin/jev-desktop.mjs secret set
```

İstem geldiğinde **TypeSafe JEV API anahtarını PowerShell terminaline yazıp Enter'a bas**. Giriş ekranda görünmez. Anahtarı sohbet mesajına, komut satırı argümanına, `.env` dosyasına veya GitHub deposuna koyma. Komut anahtarı yalnız bu kullanıcının yerel dizinindeki `%LOCALAPPDATA%\CodexJevDesktop\typesafe-key` dosyasına kaydeder; bu dosyayı elle oluşturman gerekmez.

Bu, OpenAI API anahtarı değildir. Codex Desktop hesabına giriş yapmış olman ayrıca gerekir. Anahtarın doğruluğunu daha sonra `doctor --deep` ile denetleyebilirsin.

## 3. Arka plan rölesini başlat

```powershell
node bin/jev-desktop.mjs startup-install
node bin/jev-desktop.mjs startup-start
node bin/jev-desktop.mjs doctor
```

`doctor` çıktısında `relay: "alive"` ve `startupTask: "Running"` beklenir. Bu görev mevcut Windows kullanıcısıyla düşük yetkiyle çalışır; konsolu açık bırakman gerekmez. Röle yalnızca `127.0.0.1:4319` adresini dinler. Oturum açılışında başlar ve kapanırsa yeniden başlatılmaya çalışılır.

## 4. Codex bağlantısını kur

```powershell
node bin/jev-desktop.mjs active
node bin/jev-desktop.mjs install-preview
node bin/jev-desktop.mjs install
```

`install-preview` yapılacak değişikliği gösterir. `install`, **bu bilgisayardaki** kullanıcı düzeyi Codex `config.toml` dosyasını yedekleyip `jev-auto` model sağlayıcısını ve `UserPromptSubmit` hook'unu ekler. Başka bir kişinin ayarını veya yedeğini kopyalama.

Codex'in Hooks inceleme ekranında yalnızca bu projenin `UserPromptSubmit` hook'unu inceleyip güvenilir olarak işaretle. Ardından Codex Desktop'ı tamamen kapatıp yeniden aç. Model seçicisinde **Jev Auto** seç ve reasoning göstergesini **medium** düzeyinde bırak. Medium başlangıç değeridir; gerçek model ve effort her turda rölede seçilir.

## 5. İlk çalışmayı doğrula

```powershell
node bin/jev-desktop.mjs doctor --deep
node bin/jev-desktop.mjs models
```

`doctor --deep` içinde `jevAutoInModelList: true`, `nativeCatalogReachable: true` ve normal bağlantıda `jevReachable: true` beklenir. TypeSafe ara sıra zaman aşımına uğrayabilir; bu durumda `jevStatus: "jev_timeout"` görülebilir ve röle güvenli model seçimiyle devam eder. Kalıcıysa anahtarı ve internet bağlantısını kontrol et.

Codex'te `Jev Auto` ile kısa, hassas olmayan bir görev gönder. Son yanıtta `JEV route: <model> · <effort>` satırı görünebilir. Uygulanan son kararı terminalden ayrıca inceleyebilirsin:

```powershell
node bin/jev-desktop.mjs explain
```

## Nasıl çalışır?

1. Codex Desktop isteği bilgisayarındaki yerel röleye gönderir.
2. Röle görevden sınırlı bağlamı TypeSafe JEV'e yollar. JEV model sınıfı, effort ve çalışma önerisini seçer.
3. Röle hesabının erişebildiği gerçek model listesinden uygun model/effort çiftini seçer.
4. Codex isteği gerçek OpenAI modeline iletilir; yanıtı JEV değil, seçilen Codex modeli üretir.
5. Aynı Codex oturumu korunur. Yerel arşiv eski ayrıntıları aramaya yardım eder; sınırsız, kelimesi kelimesine hafıza garanti etmez.

API anahtarı TypeSafe çağrısında kullanılır. Codex'in OpenAI kimlik bilgisi TypeSafe'e, TypeSafe anahtarı OpenAI'ye gönderilmez. Yerel röle durursa `Jev Auto` istekleri kısa süre hata verebilir; başlatıcı röleyi yeniden açmayı dener.

## Sık karşılaşılan durumlar

| Durum | Yapılacak işlem |
| --- | --- |
| `Jev Auto` görünmüyor | Codex'i tamamen kapatıp aç; `doctor --deep` çalıştır. |
| `relay: "stopped"` | `node bin/jev-desktop.mjs startup-start`, ardından `doctor` çalıştır. |
| Hook önerileri gelmiyor | Codex'in Hooks ekranında bu hook'un güvenilir ve etkin olduğunu kontrol et. |
| `jev_key_missing` veya sürekli TypeSafe hatası | `secret set` ile kendi anahtarını yeniden gir; `startup-restart` ile röleyi yeni anahtarla başlat. |
| Proje klasörü veya Node.js yolu değişti | Proje kökünde `startup-install`, sonra `startup-restart` çalıştır. |
| Model listesi hesabındakinden farklı | `doctor --deep` ve `models` çıktısını kontrol et; hesap ve Codex sürümleri farklı model erişimi verebilir. |

Anahtarı yenileme komutları:

```powershell
node bin/jev-desktop.mjs secret set
node bin/jev-desktop.mjs startup-restart
```

## Kaldırma

Proje kökünde aşağıdaki komutu çalıştır:

```powershell
node bin/jev-desktop.mjs uninstall
```

Komut kendi eklediği Codex yapılandırmasını yedekten geri getirir ve kendisine ait Windows görevini kaldırır. Yedek ve yerel arşivleri başka bilgisayara taşıma. Kaldırma hata verirse `node bin/jev-desktop.mjs rescue` ile geri almayı tekrar deneyip hata metnini incele.

Model havuzu, tur bazlı model isteği ve rapor komutları için [README](../README.md); özel depoyu arkadaşlarla paylaşma biçimi için [paylaşım kılavuzu](SHARING.md) bulunur.
