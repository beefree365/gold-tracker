using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace GoldTracker
{
    public class SpotBar
    {
        public string Timestamp { get; set; }
        public string Minute { get; set; }
        public double Open { get; set; }
        public double High { get; set; }
        public double Low { get; set; }
        public double Close { get; set; }
        public double Volume { get; set; }
    }

    public static class KlineCSharp5
    {
        private const int ImageWidth = 1400;
        private const int ImageHeight = 700;

        private static void Print(string message)
        {
            Console.WriteLine(message);
        }

        private static void Print()
        {
            Console.WriteLine();
        }

        private static string RequireEnv(string name)
        {
            var value = Environment.GetEnvironmentVariable(name);
            if (string.IsNullOrWhiteSpace(value))
                throw new Exception("Missing environment variable: " + name);
            return value;
        }

        private static string GetEnvOrDefault(string name, string fallback)
        {
            var value = Environment.GetEnvironmentVariable(name);
            return string.IsNullOrWhiteSpace(value) ? fallback : value;
        }

        private static double ToNumber(JToken token)
        {
            double value;
            if (!double.TryParse(token.ToString(), NumberStyles.Any, CultureInfo.InvariantCulture, out value))
                throw new Exception("Invalid numeric value: " + token);
            return value;
        }

        private static DateTime ParseUtcTime(string value)
        {
            return DateTime.ParseExact(
                value,
                "yyyy-MM-dd HH:mm:ss",
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
        }

        private static SpotBar NormalizeTwelveBar(JObject raw)
        {
            var timestamp = ParseUtcTime(raw["datetime"].ToString());
            var minute = new DateTime(timestamp.Year, timestamp.Month, timestamp.Day, timestamp.Hour, timestamp.Minute, 0, DateTimeKind.Utc);

            return new SpotBar
            {
                Timestamp = timestamp.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                Minute = minute.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                Open = ToNumber(raw["open"]),
                High = ToNumber(raw["high"]),
                Low = ToNumber(raw["low"]),
                Close = ToNumber(raw["close"]),
                Volume = 0
            };
        }

        private static List<SpotBar> FetchYesterdaySpotBars()
        {
            string token = RequireEnv("TWELVE_TOKEN");
            string symbol = GetEnvOrDefault("TWELVE_SYMBOL", "XAU/USD");
            string interval = GetEnvOrDefault("TWELVE_INTERVAL", "1min");

            DateTime yesterday = DateTime.UtcNow.Date.AddDays(-1);
            string startDate = yesterday.ToString("yyyy-MM-dd") + " 00:00:00";
            string endDate = yesterday.ToString("yyyy-MM-dd") + " 23:59:59";

            string url = "https://api.twelvedata.com/time_series" +
                "?symbol=" + Uri.EscapeDataString(symbol) +
                "&interval=" + Uri.EscapeDataString(interval) +
                "&outputsize=1440" +
                "&apikey=" + Uri.EscapeDataString(token) +
                "&start_date=" + Uri.EscapeDataString(startDate) +
                "&end_date=" + Uri.EscapeDataString(endDate);

            Print("Fetching data...");
            Print(url);

            var request = WebRequest.Create(url) as HttpWebRequest;
            request.UserAgent = "gold-tracker/1.0";
            request.Method = "GET";
            request.Timeout = 30000;

            string responseText;
            using (var response = request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream()))
            {
                responseText = reader.ReadToEnd();
            }

            JObject payload = JsonConvert.DeserializeObject<JObject>(responseText);

            if (payload == null || payload["status"] == null || payload["status"].ToString() != "ok")
                throw new Exception("TwelveData request failed:\n" + responseText);

            JArray values = payload["values"] as JArray;
            if (values == null || values.Count == 0)
                throw new Exception("No spot data returned.");

            var bars = new List<SpotBar>();
            foreach (JObject item in values)
            {
                bars.Add(NormalizeTwelveBar(item));
            }
            bars.Sort((a, b) => string.Compare(a.Timestamp, b.Timestamp, StringComparison.Ordinal));
            
            return bars;
        }

        private static void EnsureDirectory(string filePath)
        {
            string dir = Path.GetDirectoryName(filePath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                Directory.CreateDirectory(dir);
        }

        private static double PriceToY(double price, double minPrice, double maxPrice, double top, double height)
        {
            double span = maxPrice - minPrice;
            return span <= 0 ? top + height / 2.0 : top + height - ((price - minPrice) / span) * height;
        }

        private static void DrawSpotChart(List<SpotBar> bars, string outputPath)
        {
            EnsureDirectory(outputPath);

            Bitmap bitmap = new Bitmap(ImageWidth, ImageHeight);
            Graphics g = Graphics.FromImage(bitmap);
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;

            try
            {
                int padLeft = 100, padRight = 30, padTop = 60, padBottom = 80;
                int chartWidth = ImageWidth - padLeft - padRight;
                int chartHeight = ImageHeight - padTop - padBottom;

                g.Clear(Color.FromArgb(15, 23, 42));

                g.DrawString("Gold Spot XAU/USD", new Font("Arial", 22, FontStyle.Bold), Brushes.White, padLeft, 20);

                var prices = new List<double>();
                foreach (var b in bars)
                {
                    prices.Add(b.High);
                    prices.Add(b.Low);
                }
                double minPrice = prices.Min();
                double maxPrice = prices.Max();
                double padding = (maxPrice - minPrice) * 0.05;
                minPrice -= padding;
                maxPrice += padding;

                Pen gridPen = new Pen(Color.FromArgb(45, 55, 72));
                Font labelFont = new Font("Arial", 10);

                try
                {
                    for (int i = 0; i <= 5; i++)
                    {
                        double y = padTop + chartHeight * i / 5.0;
                        g.DrawLine(gridPen, padLeft, (float)y, ImageWidth - padRight, (float)y);
                        double price = maxPrice - (maxPrice - minPrice) * i / 5.0;
                        g.DrawString(price.ToString("F2"), labelFont, Brushes.White, 10, (float)y - 8);
                    }

                    double step = chartWidth / (double)Math.Max(bars.Count, 1);
                    int candleWidth = Math.Max(2, (int)(step * 0.6));

                    for (int i = 0; i < bars.Count; i++)
                    {
                        var bar = bars[i];
                        double x = padLeft + i * step + step / 2.0;
                        double openY = PriceToY(bar.Open, minPrice, maxPrice, padTop, chartHeight);
                        double closeY = PriceToY(bar.Close, minPrice, maxPrice, padTop, chartHeight);
                        double highY = PriceToY(bar.High, minPrice, maxPrice, padTop, chartHeight);
                        double lowY = PriceToY(bar.Low, minPrice, maxPrice, padTop, chartHeight);

                        bool isBull = bar.Close >= bar.Open;
                        Color bodyColor = isBull ? Color.LimeGreen : Color.Red;

                        Pen wickPen = new Pen(bodyColor);
                        Brush bodyBrush = new SolidBrush(bodyColor);

                        try
                        {
                            g.DrawLine(wickPen, (float)x, (float)highY, (float)x, (float)lowY);

                            float bodyTop = (float)Math.Min(openY, closeY);
                            float bodyHeight = Math.Max(2f, (float)Math.Abs(closeY - openY));
                            g.FillRectangle(bodyBrush, (float)(x - candleWidth / 2.0), bodyTop, candleWidth, bodyHeight);
                        }
                        finally
                        {
                            wickPen.Dispose();
                            bodyBrush.Dispose();
                        }
                    }
                }
                finally
                {
                    gridPen.Dispose();
                    labelFont.Dispose();
                }

                bitmap.Save(outputPath, ImageFormat.Png);
                Print("Chart saved: " + outputPath);
            }
            finally
            {
                g.Dispose();
                bitmap.Dispose();
            }
        }

        public static void Main(string[] args)
        {
            try
            {
                var bars = FetchYesterdaySpotBars();

                string csvPath = GetEnvOrDefault("YESTERDAY_SPOT_CSV_PATH", Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "output", "yesterday-spot.csv"));
                EnsureDirectory(csvPath);

                var rows = new List<string>();
                rows.Add("timestamp,minute,open,high,low,close,volume");
                
                foreach (var bar in bars)
                {
                    rows.Add(string.Format(CultureInfo.InvariantCulture, "{0},{1},{2},{3},{4},{5},{6}",
                        bar.Timestamp, bar.Minute, bar.Open, bar.High, bar.Low, bar.Close, bar.Volume));
                }

                File.WriteAllLines(csvPath, rows.ToArray(), Encoding.UTF8);
                Print("CSV saved: " + csvPath);

                string imagePath = GetEnvOrDefault("YESTERDAY_SPOT_PLOT_PATH", Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "output", "spot-chart.png"));
                DrawSpotChart(bars, imagePath);

                Print();
                Print("Bars: " + bars.Count);

                double minClose = bars.Min(x => x.Close);
                double maxClose = bars.Max(x => x.Close);
                Print("Close Range: " + minClose.ToString("F2") + " - " + maxClose.ToString("F2"));

                Print();
                Print("DONE");
            }
            catch (Exception ex)
            {
                Print();
                Print("ERROR:");
                Print(ex.Message);
                Print(ex.StackTrace);

                Environment.ExitCode = 1;
            }
        }
    }
}
