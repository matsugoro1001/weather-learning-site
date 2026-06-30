import os
import json
import base64
from http.server import SimpleHTTPRequestHandler, HTTPServer

class SaveImageHTTPRequestHandler(SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/save-images':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            
            try:
                data = json.loads(post_data.decode('utf-8'))
                year_month = data.get('yearMonth') # 例: "202512"
                images = data.get('images', {})    # 例: {"1": "data:image/png;base64,...", ...}
                
                if not year_month:
                    self.send_response(400)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(b'{"error": "Missing yearMonth"}')
                    return
                
                # 保存ディレクトリの作成
                output_dir = os.path.join('output', year_month)
                os.makedirs(output_dir, exist_ok=True)
                
                saved_count = 0
                for day_str, data_url in images.items():
                    if not data_url.startswith('data:image/png;base64,'):
                        continue
                    
                    # Base64部分をデコードして保存
                    base64_data = data_url.split(',')[1]
                    image_bytes = base64.b64decode(base64_data)
                    
                    # 2桁のゼロ埋めファイル名
                    filename = f"{int(day_str):02d}.png"
                    filepath = os.path.join(output_dir, filename)
                    
                    with open(filepath, 'wb') as f:
                        f.write(image_bytes)
                    saved_count += 1
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                response = f'{{"success": true, "message": "Saved {saved_count} images successfully to output/{year_month}"}}'
                self.wfile.write(response.encode('utf-8'))
                
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                response = f'{{"error": "{str(e)}"}}'
                self.wfile.write(response.encode('utf-8'))
        else:
            # POST以外のリクエストは親クラスに委譲
            super().do_POST()

    def do_GET(self):
        # 静的ファイルの配信は親クラスに委譲
        super().do_GET()

def run(server_class=HTTPServer, handler_class=SaveImageHTTPRequestHandler, port=8081):
    server_address = ('', port)
    httpd = server_class(server_address, handler_class)
    print(f"Starting server on port {port}... with POST /save-images handler")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        httpd.server_close()

if __name__ == '__main__':
    run()
