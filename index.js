const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

app.get('/consultar', async (req, res) => {
    const skuBuscado = req.query.sku;

    if (!skuBuscado) {
        return res.status(400).json({ error: 'Falta el parámetro SKU' });
    }

    const skuLimpio = skuBuscado.trim().toUpperCase();
    console.log(`--- Iniciando búsqueda para: ${skuLimpio} ---`);

    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process',
                '--window-size=1920,1080'
            ]
        });

        const page = await browser.newPage();
        page.setDefaultNavigationTimeout(60000); 
        page.setDefaultTimeout(60000);

        await page.setViewport({ width: 1920, height: 1080 });
        
        // 1. LOGIN
        console.log('1. Login en Portal...');
        await page.goto('https://portal.defontana.com/login', { waitUntil: 'domcontentloaded' });

        await page.waitForSelector('input[formcontrolname="email"]');
 // CREDENCIALES
        await page.type('input[formcontrolname="email"]', 'oz@microchip.cl'); 
        await page.type('input[formcontrolname="password"]', '@Emmet5264305!'); 

        await Promise.all([
            page.click('button.df-primario'),
            page.waitForNavigation({ waitUntil: 'domcontentloaded' })
        ]);
        
        console.log('2. Login OK. Abriendo ERP...');

        // 2. ABRIR PESTAÑA ERP
        const erpButtonSelector = "//h3[contains(text(), 'ERP Digital')]";
        await page.waitForXPath(erpButtonSelector);
        const [erpButton] = await page.$x(erpButtonSelector);
        
        const newTargetPromise = browser.waitForTarget(target => target.opener() === page.target());
        await erpButton.click();
        
        const newTarget = await newTargetPromise;
        const erpPage = await newTarget.page();
        
        if (!erpPage) throw new Error("No se pudo capturar la pestaña del ERP");

        erpPage.setDefaultNavigationTimeout(60000);
        erpPage.setDefaultTimeout(60000);
        await erpPage.setViewport({ width: 1920, height: 1080 });

        console.log('3. Pestaña ERP abierta. Esperando carga inicial...');
        await erpPage.waitForNavigation({ waitUntil: 'domcontentloaded' });
        // Espera de seguridad para animaciones de carga
        await new Promise(r => setTimeout(r, 4000));

        // 3. NAVEGACIÓN (MODO FUERZA BRUTA JS)
        console.log('4. Buscando menú Inventario...');
        const xpathInventario = "//span[contains(text(), 'Inventario')]";
        await erpPage.waitForXPath(xpathInventario);
        const [btnInventario] = await erpPage.$x(xpathInventario);
        
        // Clic forzado con JS (ignora overlays y animaciones)
        await erpPage.evaluate(el => el.click(), btnInventario);
        
        await new Promise(r => setTimeout(r, 1000)); // Espera a que se despliegue

        console.log('5. Clickeando Artículos...');
        const xpathArticulos = "//span[contains(text(), 'Artículos')]";
        await erpPage.waitForXPath(xpathArticulos);
        const [btnArticulos] = await erpPage.$x(xpathArticulos);
        
        // Clic forzado con JS
        await erpPage.evaluate(el => el.click(), btnArticulos);

        console.log('6. Esperando módulo de Artículos...');
        // Esperamos 5 segundos ciegos para asegurar que Angular empiece a renderizar
        await new Promise(r => setTimeout(r, 5000));

        // 4. BÚSQUEDA INTELIGENTE DEL INPUT (Frames + Selectores)
        // A veces el input cambia de ID o está en un iframe. Buscaremos en todos lados.
        
        let targetFrame = erpPage; // Por defecto buscamos en la página principal
        const searchSelectors = [
            'input[formcontrolname="searchInputText"]',
            'input[placeholder*="descripción"]', // Busca por texto del placeholder
            'input[placeholder*="Articulo"]'
        ];
        
        let foundSelector = null;

        console.log('7. Escaneando página e IFrames buscando el buscador...');

        // Función para buscar en un frame específico
        async function findSelectorInFrame(frame) {
            for (const sel of searchSelectors) {
                if (await frame.$(sel) !== null) {
                    return sel;
                }
            }
            return null;
        }

        // 1. Buscar en página principal
        foundSelector = await findSelectorInFrame(erpPage);

        // 2. Si no está, buscar en todos los iframes
        if (!foundSelector) {
            console.log('   > No encontrado en principal. Buscando en iframes...');
            for (const frame of erpPage.frames()) {
                const s = await findSelectorInFrame(frame);
                if (s) {
                    targetFrame = frame;
                    foundSelector = s;
                    console.log(`   > ¡Encontrado en iframe: ${frame.name() || 'anónimo'}!`);
                    break;
                }
            }
        }

        if (!foundSelector) {
            // Imprimimos la URL actual para depurar si falló la navegación
            const urlActual = erpPage.url();
            throw new Error(`No se encontró el cuadro de búsqueda. URL actual: ${urlActual}`);
        }

        console.log(`8. Input detectado (${foundSelector}). Escribiendo SKU...`);
        
        // Limpiar y escribir en el frame correcto
        await targetFrame.evaluate((sel) => { document.querySelector(sel).value = ""; }, foundSelector);
        await targetFrame.type(foundSelector, skuLimpio);
        await targetFrame.keyboard.press('Enter');

        // 5. ESPERAR RESULTADOS
        console.log('9. Esperando resultados...');
        try {
            // Esperamos la columna ID en el MISMO frame donde encontramos el input
            await targetFrame.waitForSelector('.mat-column-id', { timeout: 15000 });
        } catch (e) {
            console.log('...Tabla lenta o vacía...');
        }

        const resultado = await targetFrame.evaluate((sku) => {
            const filas = document.querySelectorAll('tr.mat-row');
            if (filas.length === 0) return null;

            for (let fila of filas) {
                const celdaCodigo = fila.querySelector('.mat-column-id');
                const textoCodigo = celdaCodigo ? celdaCodigo.innerText.trim() : '';

                if (textoCodigo === sku) {
                    const celdaDesc = fila.querySelector('.mat-column-description');
                    const celdaStock = fila.querySelector('.mat-column-stock');
                    const celdaPrecio = fila.querySelector('.mat-column-salePrice');

                    return {
                        codigo: textoCodigo,
                        descripcion: celdaDesc ? celdaDesc.innerText.trim() : 'Sin descripción',
                        stock: celdaStock ? celdaStock.innerText.trim() : '0',
                        precio: celdaPrecio ? celdaPrecio.innerText.trim() : '0'
                    };
                }
            }
            return null;
        }, skuLimpio);

        if (resultado) {
            res.json({ status: 'ok', mensaje: 'Producto encontrado', data: resultado });
        } else {
            res.json({
                status: 'ok',
                mensaje: 'Agotado o No encontrado',
                data: { codigo: skuLimpio, stock: '0', precio: '-' }
            });
        }

    } catch (error) {
        console.error('ERROR FATAL:', error);
        res.status(500).json({ error: 'Error interno', detalle: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(port, () => {
    console.log(`Servidor listo en puerto ${port}`);
});
