using Amazon.S3;
using Amazon.S3.Model;

namespace BackendDotnet.Services;

// Аналог backend/s3.js — тот же S3-совместимый эндпоинт (MinIO/RustFS,
// path-style, не настоящий AWS), тот же бакет, та же схема публичного URL.
public class S3Service
{
    private readonly IAmazonS3 _client;
    private readonly string _bucket;
    private readonly string _publicUrl;

    public S3Service(IConfiguration config)
    {
        var endpoint = config["S3_ENDPOINT"] ?? "";
        var accessKey = config["S3_ACCESS_KEY"] ?? "";
        var secretKey = config["S3_SECRET_KEY"] ?? "";
        _bucket = config["S3_BUCKET"] ?? "zlp-media";
        _publicUrl = (config["S3_PUBLIC_URL"] ?? "").TrimEnd('/');

        _client = new AmazonS3Client(accessKey, secretKey, new AmazonS3Config
        {
            ServiceURL = endpoint,
            ForcePathStyle = true,
        });
    }

    public async Task UploadFileAsync(string key, byte[] buffer, string contentType = "image/jpeg")
    {
        using var stream = new MemoryStream(buffer);
        await _client.PutObjectAsync(new PutObjectRequest
        {
            BucketName = _bucket,
            Key = key,
            InputStream = stream,
            ContentType = contentType,
        });
    }

    public string PublicUrl(string key) => $"{_publicUrl}/{_bucket}/{key}";
}
