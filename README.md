# API-IA-FREE: Resilient AI Proxy & Load Balancer

![API Dashboard / Architecture Placeholder](https://via.placeholder.com/1200x600?text=Dashboard+Screenshot+Here)

API-IA-FREE is a powerful, fault-tolerant proxy API designed to seamlessly manage requests across multiple free AI services. It features a robust **Round-Robin load balancing system** and a reliable **fallback/backup mechanism** ensuring uninterrupted AI service, even when primary AI providers experience downtime or rate limits.

## ✨ Key Features

- 🔄 **Round-Robin Load Balancing**: Distributes incoming requests evenly across multiple configured free AI APIs, preventing rate-limiting on a single service.
- 🛡️ **Intelligent Fallback System**: If a primary AI service fails or times out, the system automatically routes the request to a backup AI, ensuring zero downtime.
- ⚡ **High Performance**: Built with TypeScript for type-safety, speed, and maintainability.
- 📊 **Usage Tracking & Logging**: (Add details if your project has this - e.g., tracking which API is currently active or failing).

## 🚀 Use Cases

- **Cost-Effective AI Integration**: Perfect for projects that need continuous AI access without expensive pay-per-token API tiers.
- **Chatbot Backends**: Use it as the reliable brain behind Telegram, WhatsApp, or Web chatbots.
- **Microservices**: Acts as a stable unified endpoint for internal microservices requiring NLP capabilities.

## 🛠 Tech Stack

- **TypeScript** / **Node.js**
- **Express.js** (or relevant framework)

## 📦 Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/francojbe/API-IA-FREE.git
   cd API-IA-FREE
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Environment Configuration:**
   Rename `.env.example` to `.env` and configure your API endpoints:
   ```env
   PRIMARY_AI_URL_1=https://...
   PRIMARY_AI_URL_2=https://...
   BACKUP_AI_URL=https://...
   PORT=3000
   ```

4. **Run the server:**
   ```bash
   # Development
   npm run dev

   # Production
   npm run build
   npm start
   ```

## 💻 API Usage Example

**Endpoint:** `POST /api/chat`

```json
// Request
{
  "message": "Hola, ¿cómo estás?",
  "model": "default"
}

// Response
{
  "status": "success",
  "provider_used": "provider_2",
  "response": "¡Hola! Estoy listo para ayudarte."
}
```

## 🤝 Contributing
Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/francojbe/API-IA-FREE/issues).

## 📄 License
[MIT](https://choosealicense.com/licenses/mit/)
