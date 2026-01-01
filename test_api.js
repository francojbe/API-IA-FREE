async function testChat() {
    const response = await fetch('http://localhost:3000/chat', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': 'mi_proxy_secreto' // Usando el AUTH_SECRET por defecto que pusimos
        },
        body: JSON.stringify({
            messages: [{ role: 'user', content: 'Hola Groq, ¿estás ahí?' }]
        })
    });

    if (!response.ok) {
        console.error('Error:', await response.text());
        return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    console.log('Respuesta de la IA:');
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        process.stdout.write(decoder.decode(value));
    }
}

testChat();
