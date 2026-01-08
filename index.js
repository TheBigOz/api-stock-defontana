const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

// VARIABLES GLOBALES (Estado del Robot)
let globalBrowser = null;
let workPage = null; // La página única de trabajo
let robotListo = false;
let robotOcupado = false;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

// --- FUNCIÓN DE INICIO (Login + Salto Directo) ---
async function iniciarRobot() {
    console.log('🤖 INICIANDO ROBOT (Modo Directo)...');
    robotListo = false;

    try {
        if (globalBrowser) await globalBrowser.close();

        globalBrowser = await puppeteer.launch({
            headless: true, // true es más estable en Render Free
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
        workPage = page; // Guardamos la referencia

        // Tiempos generosos para el arranque
        page.setDefaultNavigationTimeout(60000);
        page.setDefaultTimeout(60000);
        await page.setViewport({ width: 1920, height: 1080 });

        // 1. LOGIN (Necesario para obtener la sesión)
        console.log('   > 1. Autenticando en Portal...');
        await page.goto('https://portal.defontana.com/login', { waitUntil: 'domcontentloaded' });
        
        await page.waitForSelector('input[formcontrolname="email"]');
  // CREDENCIALES
        await page.type('input[formcontrolname="email"]', 'oz@microchip.cl'); 
        await page.type('input[formcontrolname="password"]', '@Emmet5264305!'); 
        
        await Promise.all([
            page.click('button.df-primario'),
            page.waitForNavigation({ waitUntil: 'domcontentloaded' })
        ]);
        
        console.log('   > 2. Login OK. Esperando 5s para consolidar sesión...');
        // Esperamos un poco para que se guarden las cookies de sesión
        await new Promise(r => setTimeout(r, 5000));

        // 2. SALTO DIRECTO (Tu estrategia maestra)
        console.log('   > 3. Saltando directo a Maestro-UX (Artículos)...');
        // Usamos la misma pestaña para ahorrar memoria
        await page.goto('https://maestro-ux.defontana.com/article', { waitUntil: 'networkidle2' });

        // 3. VERIFICACIÓN
        console.log('   > 4. Esperando cuadro de búsqueda...');
        const selectorInput = 'input[formcontrolname="searchInputText"]';
        
        try {
            await page.waitForSelector(selectorInput, { timeout: 20000 });
            console.log('   ✅ ROBOT ESTACIONADO Y LISTO PARA BUSCAR');
            robotListo = true;
        } catch (e) {
            console.error('   ❌ Error: No cargó la página de artículos. Posible error de sesión.');
            throw e;
        }

    } catch (error) {
        console.error('❌ Error fatal iniciando robot:', error);
        robotListo = false;
        if (globalBrowser) await globalBrowser.close();
    }
}

// Arrancar al inicio
iniciarRobot();

// --- ENDPOINT DE CONSULTA ---
app.get('/consultar', async (req, res) => {
    const skuBuscado = req.query.sku;

    if (!skuBuscado) return res.status(400).json({ error: 'Falta SKU' });
    
    // Si el robot no está listo, intentamos revivirlo
    if (!robotListo || !workPage) {
        iniciarRobot(); // Se lanza en fondo
        return res.status(503).json({ error: 'El robot se está iniciando. Intenta en 1 minuto.' });
    }

    if (robotOcupado) {
        return res.status(429).json({ error: 'Robot ocupado. Intenta en 2 segundos.' });
    }

    robotOcupado = true;
    const skuLimpio = skuBuscado.trim().toUpperCase();
    console.log(`⚡ Buscando: ${skuLimpio}`);

    try {
        const selectorInput = 'input[formcontrolname="searchInputText"]';
        
        // 1. Limpieza y Escritura (MÉTODO TECLADO HUMANO)
        // Hacemos clic 3 veces para seleccionar todo el texto anterior (si hay)
        await workPage.click(selectorInput, { clickCount: 3 });
        await new Promise(r => setTimeout(r, 100));
        
        // Borramos con Backspace
        await workPage.keyboard.press('Backspace');
        
        // Escribimos letra por letra (Angular necesita esto)
        await workPage.type(selectorInput, skuLimpio, { delay: 50 });
        await new Promise(r => setTimeout(r, 200));
        
        // Enter
        await workPage.keyboard.press('Enter');

        // 2. Esperar Resultados
        // Esperamos a que la tabla reaccione. Si no aparece nada en 3s, asumimos vacío o carga rápida.
        try {
            // Esperamos que aparezca AL MENOS una celda de código
            await workPage.waitForSelector('.mat-column-id', { timeout: 4000 });
        } catch(e) { /* Timeout es normal si no hay resultados */ }

        // 3. Extracción de Datos (SEGÚN TUS SELECTORES)
        const resultado = await workPage.evaluate((sku) => {
            const filas = document.querySelectorAll('tr.mat-row');
            
            // Debug: Ver qué códigos estamos viendo en pantalla
            const vistos = [];

            for (let fila of filas) {
                // Usamos las clases que me indicaste (Angular Material standard)
                const celdaCodigo = fila.querySelector('.mat-column-id');
                const celdaDesc = fila.querySelector('.mat-column-description');
                const celdaStock = fila.querySelector('.mat-column-stock');
                const celdaPrecio = fila.querySelector('.mat-column-salePrice');

                const textoCodigo = celdaCodigo ? celdaCodigo.innerText.trim() : '';
                vistos.push(textoCodigo);

                // Verificamos coincidencia
                if (textoCodigo === sku || textoCodigo.includes(sku)) {
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
            return { found: false, seen: vistos };
        }, skuLimpio);

        robotOcupado = false;
        console.log('   > Resultado:', resultado);

        if (resultado.found) {
            res.json({ status: 'ok', mensaje: 'Encontrado', data: resultado.data });
        } else {
            res.json({ 
                status: 'ok', 
                mensaje: 'No encontrado', 
                debug: resultado.seen, // Para que veas qué leyó el robot
                data: { codigo: skuLimpio, stock: '0', precio: '-' } 
            });
        }

    } catch (error) {
        console.error('Error en búsqueda:', error);
        robotOcupado = false;
        // Si hay error de conexión, marcamos el robot como no listo para que se reinicie
        if (error.message.includes('Target closed') || error.message.includes('Session closed')) {
            robotListo = false;
        }
        res.status(500).json({ error: 'Error interno', detalle: error.message });
    }
});

// --- LATIDO PARA MANTENER SESIÓN VIVA ---
setInterval(async () => {
    if (robotListo && workPage) {
        try {
            // Clic en un lugar vacío para que no nos desconecte por inactividad
            await workPage.click('body'); 
        } catch(e) { robotListo = false; }
    }
}, 300000); // Cada 5 mins

app.listen(port, () => {
    console.log(`🚀 Servidor listo en puerto ${port}`);
});
