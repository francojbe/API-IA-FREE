async function testStreaming() {
    console.log('--- Iniciando prueba de Streaming Largo ---');
    const response = await fetch('http://localhost:3000/chat', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': 'mi_proxy_secreto'
        },
        body: JSON.stringify({
            messages: [{ role: 'user', content: 'Escribe un poema corto sobre la inteligencia artificial y la velocidad de Groq.' }]
        })
    });

    if (!response.ok) {
        console.error('Error:', await response.text());
        return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    process.stdout.write('IA escribiendo: ');
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        process.stdout.write(decoder.decode(value));
    }
    console.log('\n--- Prueba finalizada ---');
}

testStreaming();
