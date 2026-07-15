using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Jpeg;
using SixLabors.ImageSharp.Processing;

namespace BackendDotnet.Services;

// Аналог sharp-пайплайна из POST /api/rk/photos (server.js): основное фото —
// авто-поворот по EXIF + вписать в 1280×1280 без увеличения + JPEG q80;
// превью — обрезать/заполнить 144×144 + JPEG q70. ImageSharp.ResizeMode.Max
// = "вписать в рамку, не увеличивая" (то же, что sharp fit:'inside' +
// withoutEnlargement:true); ResizeMode.Crop = "заполнить рамку с обрезкой"
// (то же, что sharp fit:'cover').
public class PhotoService
{
    public byte[] CompressMain(byte[] input)
    {
        using var image = Image.Load(input);
        image.Mutate(x => x
            .AutoOrient()
            .Resize(new ResizeOptions { Size = new Size(1280, 1280), Mode = ResizeMode.Max }));
        using var ms = new MemoryStream();
        image.Save(ms, new JpegEncoder { Quality = 80 });
        return ms.ToArray();
    }

    public byte[] CompressThumb(byte[] compressedMain)
    {
        using var image = Image.Load(compressedMain);
        image.Mutate(x => x.Resize(new ResizeOptions { Size = new Size(144, 144), Mode = ResizeMode.Crop }));
        using var ms = new MemoryStream();
        image.Save(ms, new JpegEncoder { Quality = 70 });
        return ms.ToArray();
    }
}
