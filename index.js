const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

let globalBrowser = null;
let workPage = null;
let robotListo = false;
let robotOcupado = false;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

// --- FUNCIÓN DE INICIO ---
async function iniciarRobot() {
    console.log('🤖 INICIANDO ROBOT (Modo Persistente)...');
    robotListo = false;

    try {
        if (globalBrowser) await globalBrowser.close();

        globalBrowser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process',
                '--no-zygote',
                '--window-size=1920,1080'
            ]
        });

        const page = await globalBrowser.newPage();
        workPage = page;

        page.setDefaultNavigationTimeout(60000);
        page.setDefaultTimeout(60000);
        await page.setViewport({ width: 1920, height: 1080 });

        // 1. LOGIN
        console.log('   > 1. Autenticando...');
        await page.goto('https://portal.defontana.com/login', { waitUntil: 'domcontentloaded' });
        
        await page.waitForSelector('input[formcontrolname="email"]');
          // CREDENCIALES
        await page.type('input[formcontrolname="email"]', 'oz@microchip.cl'); 
        await page.type('input[formcontrolname="password"]', '@Emmet5264305!'); 

        await Promise.all([
            page.click('button.df-primario'),
            page.waitForNavigation({ waitUntil: 'domcontentloaded' })
        ]);
        
        console.log('   > 2. Login OK. Consolidando (5s)...');
        await new Promise(r => setTimeout(r, 5000));

        // 2. SALTO DIRECTO
        console.log('   > 3. Saltando a Maestro-UX...');
        await page.goto('https://maestro-ux.defontana.com/article', { waitUntil: 'networkidle2' });

        // 3. VERIFICACIÓN PROFUNDA (Aquí estaba el fallo antes)
        console.log('   > 4. Esperando buscador y TABLA...');
        const selectorInput = 'input[formcontrolname="searchInputText"]';
        
        // Esperamos el input
        await page.waitForSelector(selectorInput, { timeout: 30000 });
        
        // --- NUEVO: Esperamos a que la tabla cargue datos iniciales ---
        // Si no esperamos esto, el robot busca en el vacío.
        try {
            console.log('   > ...Esperando que aparezca la grilla de datos...');
            await page.waitForSelector('tr.mat-row', { timeout: 20000 });
            console.log('   > ¡Tabla detectada!');
        } catch(e) {
            console.log('   ⚠️ Advertencia: La tabla inicial tardó mucho o está vacía.');
        }

        console.log('   ✅ ROBOT ESTACIONADO Y LISTO');
        robotListo = true;

    } catch (error) {
        console.error('❌ Error iniciando:', error);
        robotListo = false;
        if (globalBrowser) await globalBrowser.close();
    }
}

iniciarRobot();

// --- ENDPOINT CONSULTA ---
app.get('/consultar', async (req, res) => {
    const skuBuscado = req.query.sku;
    if (!skuBuscado) return res.status(400).json({ error: 'Falta SKU' });
    
    if (!robotListo || !workPage) {
        iniciarRobot(); 
        return res.status(503).json({ error: 'Reiniciando sistema...' });
    }

    if (robotOcupado) return res.status(429).json({ error: 'Ocupado.' });

    robotOcupado = true;
    const skuLimpio = skuBuscado.trim().toUpperCase();
    console.log(`⚡ Buscando: ${skuLimpio}`);

    try {
        const selectorInput = 'input[formcontrolname="searchInputText"]';

        // 1. ESCRITURA "ATÓMICA" (Inyección directa a Angular)
        // Esto garantiza que el texto quede escrito sí o sí.
        const valorReal = await workPage.evaluate((sel, texto) => {
            const input = document.querySelector(sel);
            if (!input) return null;

            // 1. Foco
            input.focus();
            
            // 2. Asignación directa
            input.value = texto;
            
            // 3. Disparar eventos para que Angular se despierte
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            
            return input.value; // Devolvemos para verificar
        }, selectorInput, skuLimpio);

        console.log(`   > Texto inyectado: "${valorReal}". Presionando Enter...`);
        
        // Esperamos un milisegundo y damos Enter
        await new Promise(r => setTimeout(r, 200));
        await workPage.keyboard.press('Enter');

        // 2. ESPERA INTELIGENTE
        // Esperamos 3 segundos fijos para dar tiempo a la búsqueda
        await new Promise(r => setTimeout(r, 3000));

        // 3. EXTRACCIÓN
        const resultado = await workPage.evaluate((sku) => {
            // Buscamos filas
            const filas = document.querySelectorAll('tr.mat-row');
            const vistos = [];

            // Si no hay filas, devolvemos error específico
            if (filas.length === 0) {
                return { found: false, count: 0, htmlBody: document.body.innerText.substring(0, 100) }; // Debug extremo
            }

            for (let fila of filas) {
                // Selectores EXACTOS que me diste
                const celdaCodigo = fila.querySelector('.mat-column-id');
                const celdaDesc = fila.querySelector('.mat-column-description');
                const celdaStock = fila.querySelector('.mat-column-stock span'); // Ojo al span
                const celdaPrecio = fila.querySelector('.mat-column-salePrice');

                const textoCodigo = celdaCodigo ? celdaCodigo.innerText.trim() : '???';
                vistos.push(textoCodigo);

                // Comparamos (Includes es más seguro por si hay espacios)
                if (textoCodigo.includes(sku)) {
                    return {
                        found: true,
                        data: {
                            codigo: textoCodigo,
                            descripcion: celdaDesc ? celdaDesc.innerText.trim() : 'Sin descripción',
                            stock: celdaStock ? celdaStock.innerText.trim() : '0',
                            precio: celdaPrecio ? celdaPrecio.innerText.trim() : '0'
                        }
                    };
                }
            }
            return { found: false, count: filas.length, seen: vistos };
        }, skuLimpio);

        robotOcupado = false;
        console.log('   > Resultado:', resultado);

        if (resultado.found) {
            res.json({ status: 'ok', mensaje: 'Encontrado', data: resultado.data });
        } else {
            // Analizamos por qué falló
            let msg = 'No encontrado';
            if (resultado.count === 0) msg = 'Error: La tabla aparece vacía.';

            res.json({ 
                status: 'ok', 
                mensaje: msg, 
                debug: resultado, 
                data: { codigo: skuLimpio, stock: '0', precio: '-' } 
            });
        }

    } catch (error) {
        console.error('Error búsqueda:', error);
        robotOcupado = false;
        // Si se cerró la sesión, marcamos para reinicio
        if (error.message.includes('Target closed') || error.message.includes('Session closed')) {
            robotListo = false;
        }
        res.status(500).json({ error: 'Error interno', detalle: error.message });
    }
});

// Ping para mantener vivo
setInterval(async () => {
    if (robotListo && workPage) {
        try { await workPage.evaluate(() => document.body.click()); } catch(e) {}
    }
}, 300000);

app.listen(port, () => {
    console.log(`🚀 Servidor listo en puerto ${port}`);
});
