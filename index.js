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
        console.log('1. Entrando al Portal...');
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
        
        // Abrimos la pestaña
        await erpButton.click();
        
        // Esperamos un poco para asegurarnos que la pestaña se creó
        await new Promise(r => setTimeout(r, 5000));

        // 3. RECUPERACIÓN DE LA PESTAÑA (EL TRUCO NUEVO)
        // En lugar de usar la referencia 'target', pedimos al navegador todas las pestañas abiertas.
        // La última de la lista SIEMPRE es la nueva que se acaba de abrir.
        const pages = await browser.pages();
        const erpPage = pages[pages.length - 1]; // Tomamos la última pestaña (la del ERP)

        if (!erpPage) throw new Error("No se pudo detectar la pestaña del ERP");

        erpPage.setDefaultNavigationTimeout(60000);
        erpPage.setDefaultTimeout(60000);
        await erpPage.setViewport({ width: 1920, height: 1080 });

        console.log('3. Pestaña capturada (Refrescada). ESPERANDO 15 SEGUNDOS...');
        // Dejamos que cargue tranquila
        await new Promise(r => setTimeout(r, 15000));

        // 4. NAVEGACIÓN POR CLICS (Con la referencia fresca)
        console.log('4. Tiempo cumplido. Buscando menú Inventario...');
        
        // Usamos XPath que es más seguro para texto
        const xpathInventario = "//span[contains(text(), 'Inventario')]";
        try {
            await erpPage.waitForXPath(xpathInventario, { visible: true, timeout: 10000 });
            const [btnInventario] = await erpPage.$x(xpathInventario);
            // Clic JS
            await erpPage.evaluate(el => el.click(), btnInventario);
            console.log('   > Clic en Inventario OK');
        } catch (e) {
            console.log('   > No encontré botón Inventario (¿Quizás ya estaba desplegado?)');
        }

        await new Promise(r => setTimeout(r, 1000));

        console.log('5. Buscando submenú Artículos...');
        const xpathArticulos = "//span[contains(text(), 'Artículos')]";
        await erpPage.waitForXPath(xpathArticulos, { visible: true });
        const [btnArticulos] = await erpPage.$x(xpathArticulos);
        await erpPage.evaluate(el => el.click(), btnArticulos);

        console.log('6. Esperando módulo de Artículos (5 seg)...');
        await new Promise(r => setTimeout(r, 5000));

        // 5. BÚSQUEDA DEL INPUT (Escaneo de seguridad)
        console.log('7. Buscando el INPUT...');
        
        // Probamos buscar en la página principal primero
        let targetFrame = erpPage;
        const searchInputSelector = 'input[formcontrolname="searchInputText"]';
        
        // Verificamos si está en un iframe (Común en ERPs)
        const frame = erpPage.frames().find(f => f.name().includes('frame') || f.url().includes('Articulos'));
        if (frame) {
            console.log('   > Detectado posible iframe de contenido.');
            targetFrame = frame;
        }

        // Esperamos el selector
        try {
            await targetFrame.waitForSelector(searchInputSelector, { timeout: 10000 });
        } catch(e) {
            // Último intento: buscar por placeholder
            console.log('   > Selector primario falló. Probando placeholder...');
        }

        // Escribimos (usando una estrategia genérica si el selector falló)
        // Buscamos cualquier input que parezca de búsqueda
        const inputHandle = await targetFrame.$('input[formcontrolname="searchInputText"]') || 
                            await targetFrame.$('input[placeholder*="descripción"]');

        if (!inputHandle) throw new Error("No se pudo encontrar ningún campo de búsqueda.");

        console.log(`8. Input encontrado. Escribiendo SKU: ${skuLimpio}`);
        
        // Limpieza y escritura segura
        await inputHandle.click({ clickCount: 3 });
        await inputHandle.type(skuLimpio);
        await inputHandle.press('Enter');

        // 6. RESULTADOS
        console.log('9. Esperando tabla...');
        try {
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
